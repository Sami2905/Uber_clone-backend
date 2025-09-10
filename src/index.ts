import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import http from "http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import Stripe from "stripe";
import { supabase, isSupabaseReady } from "./supabase";
import { requireAuth } from "./auth";

const app = express();
// Security & body parsing
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
// Conditionally skip JSON parsing for Stripe webhook path
app.use((req, res, next) => {
	if (req.path === "/webhooks/stripe") return next();
	return express.json()(req, res, next);
});
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(morgan("dev"));

app.get("/health", (_req, res) => {
	return res.json({ status: "ok" });
});

// Utilities
function toRad(n: number) { return (n * Math.PI) / 180; }
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
	const R = 6371;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const h = Math.sin(dLat/2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

// In-memory store (MVP)
type Ride = {
	id: string;
	pickup: { lat: number; lng: number };
	dropoff: { lat: number; lng: number };
	rideType: "standard" | "premium" | "xl";
	status: "requested" | "matched" | "accepted" | "in_progress" | "completed" | "cancelled";
	driverId?: string;
  quoteUsd?: number;
  paymentIntentId?: string;
};
const rides = new Map<string, Ride>();

// Ride routes skeleton
const rideRequestSchema = z.object({
	pickup: z.object({ lat: z.number(), lng: z.number() }),
	dropoff: z.object({ lat: z.number(), lng: z.number() }),
	rideType: z.enum(["standard", "premium", "xl"]).default("standard"),
});

app.post("/rides", requireAuth(["rider", "admin"]), (req, res) => {
	const parse = rideRequestSchema.safeParse(req.body);
	if (!parse.success) {
		return res.status(400).json({ error: { code: "VALIDATION_ERROR", details: parse.error.flatten() } });
	}
	const rideId = `ride_${Date.now()}`;
	// attach quote estimate
	const km = haversineKm(parse.data.pickup, parse.data.dropoff);
	const perKm = parse.data.rideType === "premium" ? 1.8 : parse.data.rideType === "xl" ? 2.0 : 1.2;
	const quoteUsd = Math.max(5, Math.round((2.5 + km * perKm) * 100) / 100);
	const ride: Ride = { id: rideId, status: "requested", quoteUsd, ...parse.data };
	rides.set(rideId, ride);
	// Best-effort persist
	(async () => {
		try {
			if (isSupabaseReady()) {
				await supabase!.from("rides").insert({
					id: ride.id,
					pickup_lat: ride.pickup.lat,
					pickup_lng: ride.pickup.lng,
					dropoff_lat: ride.dropoff.lat,
					dropoff_lng: ride.dropoff.lng,
					ride_type: ride.rideType,
					status: ride.status,
					quote_usd: ride.quoteUsd,
				});
			}
		} catch {}
	})();
	broadcastToRide(rideId, { type: "ride.updated", ride });
	return res.status(201).json(ride);
});

app.get("/rides/:id", requireAuth(["rider", "driver", "admin"]), (req, res) => {
	const ride = rides.get(req.params.id);
	if (!ride) return res.status(404).json({ error: { code: "NOT_FOUND" } });
	return res.json(ride);
});

const acceptSchema = z.object({ driverId: z.string().min(1) });
app.post("/rides/:id/accept", requireAuth(["driver", "admin"]), (req, res) => {
	const ride = rides.get(req.params.id);
	if (!ride) return res.status(404).json({ error: { code: "NOT_FOUND" } });
	if (ride.status !== "requested") return res.status(409).json({ error: { code: "INVALID_STATE" } });
	const parsed = acceptSchema.safeParse(req.body);
	if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
	ride.status = "accepted";
	ride.driverId = parsed.data.driverId;
	rides.set(ride.id, ride);
	broadcastToRide(ride.id, { type: "ride.updated", ride });
	(async () => {
		try {
			if (isSupabaseReady()) {
				await supabase!.from("rides").update({ status: ride.status, driver_id: ride.driverId, updated_at: new Date().toISOString() }).eq("id", ride.id);
			}
		} catch {}
	})();
	return res.json(ride);
});

// Start and complete
app.post("/rides/:id/start", requireAuth(["driver", "admin"]), (req, res) => {
	const ride = rides.get(req.params.id);
	if (!ride) return res.status(404).json({ error: { code: "NOT_FOUND" } });
	if (ride.status !== "accepted") return res.status(409).json({ error: { code: "INVALID_STATE" } });
	ride.status = "in_progress";
	rides.set(ride.id, ride);
	broadcastToRide(ride.id, { type: "ride.updated", ride });
	(async () => {
		try {
			if (isSupabaseReady()) {
				await supabase!.from("rides").update({ status: ride.status, updated_at: new Date().toISOString() }).eq("id", ride.id);
			}
		} catch {}
	})();
	return res.json(ride);
});

app.post("/rides/:id/complete", requireAuth(["driver", "admin"]), async (req, res) => {
	const ride = rides.get(req.params.id);
	if (!ride) return res.status(404).json({ error: { code: "NOT_FOUND" } });
	if (ride.status !== "in_progress" && ride.status !== "accepted") return res.status(409).json({ error: { code: "INVALID_STATE" } });
	ride.status = "completed";
	rides.set(ride.id, ride);
	broadcastToRide(ride.id, { type: "ride.updated", ride });
	(async () => {
		try {
			if (isSupabaseReady()) {
				await supabase!.from("rides").update({ status: ride.status, updated_at: new Date().toISOString() }).eq("id", ride.id);
			}
		} catch {}
	})();
	// Attempt payment capture if a PI exists (future wiring)
	try {
		if (process.env.STRIPE_SECRET_KEY && ride.paymentIntentId) {
			await stripe.paymentIntents.capture(ride.paymentIntentId);
		}
	} catch {}
	return res.json(ride);
});

// Fare estimation
const quoteSchema = rideRequestSchema;
app.post("/rides/quote", (req, res) => {
	const parsed = quoteSchema.safeParse(req.body);
	if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
	const { pickup, dropoff, rideType } = parsed.data;
	const km = haversineKm(pickup, dropoff);
	const base = 2.5; // base fare
	const perKm = rideType === "premium" ? 1.8 : rideType === "xl" ? 2.0 : 1.2;
	const estimate = Math.max(5, Math.round((base + km * perKm) * 100) / 100);
	return res.json({ distanceKm: +km.toFixed(2), currency: "usd", estimate });
});

// Stripe webhook scaffold
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_", {
	apiVersion: "2024-06-20",
});

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
	const sig = req.headers["stripe-signature"] as string | undefined;
	if (!sig) return res.status(400).send("Missing signature");
	try {
		const event = stripe.webhooks.constructEvent(
			req.body,
			sig,
			process.env.STRIPE_WEBHOOK_SECRET || "whsec_"
		);
		// TODO: handle events (payment_intent.succeeded, etc.)
		return res.json({ received: true, type: event.type });
	} catch (err) {
		return res.status(400).send(`Webhook Error`);
	}
});

// Create PaymentIntent
app.post("/payments/intent", async (req, res) => {
	if (!process.env.STRIPE_SECRET_KEY) return res.status(400).json({ error: { code: "STRIPE_NOT_CONFIGURED" } });
	const body = (req.body ?? {}) as { amount?: number; rideId?: string };
	const amount = body.amount && body.amount > 0 ? Math.round(body.amount * 100) : undefined;
	if (!amount) return res.status(400).json({ error: { code: "INVALID_AMOUNT" } });
	try {
		const pi = await stripe.paymentIntents.create({ amount, currency: "usd", metadata: { rideId: body.rideId ?? "" } });
		return res.json({ clientSecret: pi.client_secret });
	} catch (e) {
		return res.status(500).json({ error: { code: "STRIPE_ERROR" } });
	}
});

// Basic ride history (all rides, MVP)
app.get("/rides", requireAuth(["admin"]), (_req, res) => {
	return res.json({ items: Array.from(rides.values()).sort((a,b) => a.id < b.id ? 1 : -1) });
});

// Server + WS
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Ride rooms
const rideRooms = new Map<string, Set<WebSocket>>();
function addSocketToRide(rideId: string, ws: WebSocket) {
	if (!rideRooms.has(rideId)) rideRooms.set(rideId, new Set());
	rideRooms.get(rideId)!.add(ws);
	ws.on("close", () => rideRooms.get(rideId)?.delete(ws));
}
function broadcastToRide(rideId: string, payload: unknown) {
	const room = rideRooms.get(rideId);
	if (!room) return;
	const data = JSON.stringify(payload);
	for (const client of room) {
		try { client.send(data); } catch {}
	}
}

wss.on("connection", (socket, req) => {
	const url = new URL(req.url || "", `http://${req.headers.host}`);
	const rideId = url.searchParams.get("rideId");
	if (rideId) {
		addSocketToRide(rideId, socket);
		const snapshot = rides.get(rideId);
		if (snapshot) socket.send(JSON.stringify({ type: "ride.snapshot", ride: snapshot }));
	} else {
		socket.send(JSON.stringify({ type: "hello", ts: Date.now() }));
	}
	// Generic echo for debugging
	socket.on("message", (data) => {
		try { const msg = JSON.parse(String(data)); socket.send(JSON.stringify({ type: "echo", payload: msg })); }
		catch { socket.send(JSON.stringify({ type: "error", message: "invalid_json" })); }
	});
});

const port = Number(process.env.PORT || 4000);
server.listen(port, () => {
	// eslint-disable-next-line no-console
	console.log(`API listening on http://localhost:${port}`);
});

// Central error handler (fallback)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	return res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR" } });
});


