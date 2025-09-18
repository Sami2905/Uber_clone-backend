"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const morgan_1 = __importDefault(require("morgan"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const zod_1 = require("zod");
const stripe_1 = __importDefault(require("stripe"));
const supabase_1 = require("./supabase");
const auth_1 = require("./auth");
const app = (0, express_1.default)();
// Security & body parsing
app.use((0, helmet_1.default)());
app.use((0, express_rate_limit_1.default)({ windowMs: 60000, max: 120 }));
// Conditionally skip JSON parsing for Stripe webhook path
app.use((req, res, next) => {
    if (req.path === "/webhooks/stripe")
        return next();
    return express_1.default.json()(req, res, next);
});
app.use((0, cors_1.default)({ origin: process.env.CORS_ORIGIN || "*" }));
app.use((0, morgan_1.default)("dev"));
app.get("/health", (_req, res) => {
    return res.json({ status: "ok" });
});
// Liveness & Readiness
app.get("/live", (_req, res) => res.status(200).send("OK"));
app.get("/ready", (_req, res) => {
    return res.json({
        api: true,
        supabase: (0, supabase_1.isSupabaseReady)(),
        stripe: Boolean(process.env.STRIPE_SECRET_KEY),
        clerk: Boolean(process.env.CLERK_JWKS_URL),
    });
});
// Utilities
function toRad(n) { return (n * Math.PI) / 180; }
function haversineKm(a, b) {
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
const rides = new Map();
const ratings = new Map();
// Ride routes skeleton
const rideRequestSchema = zod_1.z.object({
    pickup: zod_1.z.object({ lat: zod_1.z.number(), lng: zod_1.z.number() }),
    dropoff: zod_1.z.object({ lat: zod_1.z.number(), lng: zod_1.z.number() }),
    rideType: zod_1.z.enum(["standard", "premium", "xl"]).default("standard"),
});
app.post("/rides", (0, auth_1.requireAuth)(["rider", "admin"]), (req, res) => {
    const parse = rideRequestSchema.safeParse(req.body);
    if (!parse.success) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", details: parse.error.flatten() } });
    }
    const rideId = `ride_${Date.now()}`;
    // attach quote estimate
    const km = haversineKm(parse.data.pickup, parse.data.dropoff);
    const perKm = parse.data.rideType === "premium" ? 1.8 : parse.data.rideType === "xl" ? 2.0 : 1.2;
    const quoteUsd = Math.max(5, Math.round((2.5 + km * perKm) * 100) / 100);
    const ride = { id: rideId, status: "requested", quoteUsd, ...parse.data };
    rides.set(rideId, ride);
    // Best-effort persist
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").insert({
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
        }
        catch { }
    })();
    broadcastToRide(rideId, { type: "ride.updated", ride });
    return res.status(201).json(ride);
});
app.get("/rides/:id", (0, auth_1.requireAuth)(["rider", "driver", "admin"]), (req, res) => {
    const rideId = req.params.id;
    (async () => {
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                const { data, error } = await supabase_1.supabase.from("rides").select("id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,ride_type,status,driver_id,quote_usd,payment_intent_id").eq("id", rideId).maybeSingle();
                if (error)
                    throw error;
                if (data) {
                    const mapped = {
                        id: data.id,
                        pickup: { lat: Number(data.pickup_lat), lng: Number(data.pickup_lng) },
                        dropoff: { lat: Number(data.dropoff_lat), lng: Number(data.dropoff_lng) },
                        rideType: String(data.ride_type),
                        status: String(data.status),
                        driverId: data.driver_id || undefined,
                        quoteUsd: data.quote_usd ?? undefined,
                        paymentIntentId: data.payment_intent_id || undefined,
                    };
                    return res.json(mapped);
                }
            }
            catch { }
        }
        const ride = rides.get(rideId);
        if (!ride)
            return res.status(404).json({ error: { code: "NOT_FOUND" } });
        return res.json(ride);
    })();
});
const acceptSchema = zod_1.z.object({ driverId: zod_1.z.string().min(1) });
app.post("/rides/:id/accept", (0, auth_1.requireAuth)(["driver", "admin"]), async (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (ride.status !== "requested")
        return res.status(409).json({ error: { code: "INVALID_STATE" } });
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    ride.status = "accepted";
    ride.driverId = parsed.data.driverId;
    // Create PaymentIntent on accept (manual capture) with idempotency
    if (process.env.STRIPE_SECRET_KEY && ride.quoteUsd && !ride.paymentIntentId) {
        try {
            const amountCents = Math.max(1, Math.round(ride.quoteUsd * 100));
            const pi = await stripe.paymentIntents.create({
                amount: amountCents,
                currency: "usd",
                capture_method: "manual",
                metadata: { rideId: ride.id },
            }, { idempotencyKey: `ride_accept_${ride.id}` });
            ride.paymentIntentId = pi.id;
        }
        catch { }
    }
    rides.set(ride.id, ride);
    broadcastToRide(ride.id, { type: "ride.updated", ride });
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").update({ status: ride.status, driver_id: ride.driverId, payment_intent_id: ride.paymentIntentId ?? null, updated_at: new Date().toISOString() }).eq("id", ride.id);
            }
        }
        catch { }
    })();
    return res.json(ride);
});
// Start and complete
app.post("/rides/:id/start", (0, auth_1.requireAuth)(["driver", "admin"]), (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (ride.status !== "accepted")
        return res.status(409).json({ error: { code: "INVALID_STATE" } });
    ride.status = "in_progress";
    rides.set(ride.id, ride);
    broadcastToRide(ride.id, { type: "ride.updated", ride });
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").update({ status: ride.status, updated_at: new Date().toISOString() }).eq("id", ride.id);
            }
        }
        catch { }
    })();
    return res.json(ride);
});
app.post("/rides/:id/complete", (0, auth_1.requireAuth)(["driver", "admin"]), async (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (ride.status !== "in_progress" && ride.status !== "accepted")
        return res.status(409).json({ error: { code: "INVALID_STATE" } });
    ride.status = "completed";
    rides.set(ride.id, ride);
    broadcastToRide(ride.id, { type: "ride.updated", ride });
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").update({ status: ride.status, updated_at: new Date().toISOString() }).eq("id", ride.id);
            }
        }
        catch { }
    })();
    // Attempt payment capture if a PI exists
    try {
        if (process.env.STRIPE_SECRET_KEY && ride.paymentIntentId) {
            await stripe.paymentIntents.capture(ride.paymentIntentId, undefined, { idempotencyKey: `ride_complete_${ride.id}` });
        }
    }
    catch { }
    return res.json(ride);
});
// Driver live location update -> broadcast to ride room
const driverLocSchema = zod_1.z.object({ lat: zod_1.z.number().gte(-90).lte(90), lng: zod_1.z.number().gte(-180).lte(180) });
app.post("/rides/:id/driver_location", (0, auth_1.requireAuth)(["driver", "admin"]), (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const parsed = driverLocSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    ride.driverLat = parsed.data.lat;
    ride.driverLng = parsed.data.lng;
    rides.set(ride.id, ride);
    broadcastToRide(ride.id, { type: "driver.location", coords: parsed.data });
    // best-effort persist
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").update({ driver_lat: parsed.data.lat, driver_lng: parsed.data.lng, updated_at: new Date().toISOString() }).eq("id", ride.id);
            }
        }
        catch { }
    })();
    return res.json({ ok: true });
});
// Cancel a ride (free before accept)
app.post("/rides/:id/cancel", (0, auth_1.requireAuth)(["rider", "admin"]), async (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (ride.status !== "requested")
        return res.status(409).json({ error: { code: "INVALID_STATE" } });
    ride.status = "cancelled";
    rides.set(ride.id, ride);
    broadcastToRide(ride.id, { type: "ride.updated", ride });
    (async () => {
        try {
            if ((0, supabase_1.isSupabaseReady)()) {
                await supabase_1.supabase.from("rides").update({ status: ride.status, updated_at: new Date().toISOString() }).eq("id", ride.id);
            }
        }
        catch { }
    })();
    return res.json(ride);
});
// Ratings API
const ratingSchema = zod_1.z.object({ stars: zod_1.z.number().min(1).max(5), comment: zod_1.z.string().max(300).optional() });
app.post("/rides/:id/rating", (0, auth_1.requireAuth)(["rider", "admin"]), async (req, res) => {
    const rideId = req.params.id;
    const parsed = ratingSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    ratings.set(rideId, { rideId, ...parsed.data });
    if ((0, supabase_1.isSupabaseReady)()) {
        try {
            await supabase_1.supabase.from("ride_ratings").insert({ ride_id: rideId, stars: parsed.data.stars, comment: parsed.data.comment ?? null });
        }
        catch { }
    }
    return res.json({ ok: true });
});
// Fare estimation
const quoteSchema = rideRequestSchema;
app.post("/rides/quote", (req, res) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    const { pickup, dropoff, rideType } = parsed.data;
    const km = haversineKm(pickup, dropoff);
    const base = 2.5; // base fare
    const perKm = rideType === "premium" ? 1.8 : rideType === "xl" ? 2.0 : 1.2;
    const estimate = Math.max(5, Math.round((base + km * perKm) * 100) / 100);
    return res.json({ distanceKm: +km.toFixed(2), currency: "usd", estimate });
});
// Stripe
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY || "sk_test_", {
    apiVersion: "2024-06-20",
});
// Webhook idempotency (DB-first with in-memory fallback)
const processedStripeEvents = new Set();
async function isEventProcessed(id) {
    if ((0, supabase_1.isSupabaseReady)()) {
        try {
            const { data } = await supabase_1.supabase.from("stripe_events").select("id").eq("id", id).maybeSingle();
            if (data?.id)
                return true;
        }
        catch { }
    }
    return processedStripeEvents.has(id);
}
async function markEventProcessed(id, type) {
    if ((0, supabase_1.isSupabaseReady)()) {
        try {
            await supabase_1.supabase.from("stripe_events").insert({ id, type, processed_at: new Date().toISOString() });
            return;
        }
        catch { }
    }
    processedStripeEvents.add(id);
    if (processedStripeEvents.size > 1000) {
        const first = processedStripeEvents.values().next().value;
        if (first)
            processedStripeEvents.delete(first);
    }
}
app.post("/webhooks/stripe", express_1.default.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig)
        return res.status(400).send("Missing signature");
    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || "whsec_");
        if (await isEventProcessed(event.id))
            return res.json({ received: true, duplicate: true });
        switch (event.type) {
            case "payment_intent.succeeded":
            case "payment_intent.canceled":
            case "payment_intent.payment_failed":
                // placeholder for DB updates
                break;
            default:
                break;
        }
        await markEventProcessed(event.id, event.type);
        return res.json({ received: true, type: event.type });
    }
    catch (err) {
        return res.status(400).send(`Webhook Error`);
    }
});
// Create PaymentIntent
app.post("/payments/intent", async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY)
        return res.status(400).json({ error: { code: "STRIPE_NOT_CONFIGURED" } });
    const body = (req.body ?? {});
    const amount = body.amount && body.amount > 0 ? Math.round(body.amount * 100) : undefined;
    if (!amount)
        return res.status(400).json({ error: { code: "INVALID_AMOUNT" } });
    try {
        const pi = await stripe.paymentIntents.create({ amount, currency: "usd", metadata: { rideId: body.rideId ?? "" } });
        return res.json({ clientSecret: pi.client_secret });
    }
    catch (e) {
        return res.status(500).json({ error: { code: "STRIPE_ERROR" } });
    }
});
// Basic ride history (all rides, MVP)
app.get("/rides", (0, auth_1.requireAuth)(["admin"]), (_req, res) => {
    (async () => {
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                const { data, error } = await supabase_1.supabase.from("rides").select("id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,ride_type,status,driver_id,quote_usd,payment_intent_id").order("created_at", { ascending: false });
                if (error)
                    throw error;
                if (data) {
                    const items = data.map((r) => ({
                        id: r.id,
                        pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
                        dropoff: { lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng) },
                        rideType: String(r.ride_type),
                        status: String(r.status),
                        driverId: r.driver_id || undefined,
                        quoteUsd: r.quote_usd ?? undefined,
                        paymentIntentId: r.payment_intent_id || undefined,
                    }));
                    return res.json({ items });
                }
            }
            catch { }
        }
        return res.json({ items: Array.from(rides.values()).sort((a, b) => a.id < b.id ? 1 : -1) });
    })();
});
// Open rides for drivers to accept
app.get("/rides/open", (0, auth_1.requireAuth)(["driver", "admin"]), async (_req, res) => {
    if ((0, supabase_1.isSupabaseReady)()) {
        try {
            const { data, error } = await supabase_1.supabase.from("rides").select("id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,ride_type,status,quote_usd").eq("status", "requested").order("created_at", { ascending: false });
            if (error)
                throw error;
            const items = (data || []).map((r) => ({
                id: r.id,
                pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
                dropoff: { lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng) },
                rideType: r.ride_type,
                status: r.status,
                quoteUsd: r.quote_usd ?? undefined,
            }));
            return res.json({ items });
        }
        catch { }
    }
    // fallback to in-memory
    const items = Array.from(rides.values()).filter(r => r.status === "requested").sort((a, b) => a.id < b.id ? 1 : -1);
    return res.json({ items });
});
app.get("/rides/:id/receipt", (0, auth_1.requireAuth)(["rider", "driver", "admin"]), (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const distanceKm = haversineKm(ride.pickup, ride.dropoff);
    const base = 2.5;
    const perKm = ride.rideType === "premium" ? 1.8 : ride.rideType === "xl" ? 2.0 : 1.2;
    const subtotal = Math.max(5, Math.round((base + distanceKm * perKm) * 100) / 100);
    const taxes = Math.round(subtotal * 0.1 * 100) / 100; // 10% demo tax
    const total = Math.round((subtotal + taxes) * 100) / 100;
    const lines = [
        "Uber Clone Receipt",
        `Ride: ${ride.id}`,
        `Status: ${ride.status}`,
        `Type: ${ride.rideType}`,
        `Distance: ${distanceKm.toFixed(2)} km`,
        `Base: $${base.toFixed(2)}`,
        `Rate/km: $${perKm.toFixed(2)}`,
        `Subtotal: $${subtotal.toFixed(2)}`,
        `Taxes (10%): $${taxes.toFixed(2)}`,
        `Total: $${total.toFixed(2)}`,
        ride.paymentIntentId ? `PaymentIntent: ${ride.paymentIntentId}` : "PaymentIntent: -",
        "",
        "Thank you for riding with us!",
    ];
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(lines.join("\n"));
});
const tickets = new Map();
app.post("/support/tickets", (0, auth_1.requireAuth)(["rider", "driver", "admin"]), (req, res) => {
    const b = (req.body ?? {});
    if (!b.subject || !b.category)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    const id = `tkt_${Date.now()}`;
    const t = { id, userId: req.auth?.sub, rideId: b.rideId, category: b.category, subject: b.subject, status: "open", messages: [] };
    if (b.message)
        t.messages.push({ at: new Date().toISOString(), from: "user", text: b.message });
    tickets.set(id, t);
    (async () => {
        if (!(0, supabase_1.isSupabaseReady)())
            return;
        try {
            await supabase_1.supabase.from("support_tickets").insert({ id, user_id: t.userId ?? null, ride_id: t.rideId ?? null, category: t.category, subject: t.subject, status: t.status, created_at: new Date().toISOString() });
            if (b.message) {
                await supabase_1.supabase.from("support_messages").insert({ ticket_id: id, from_role: "user", text: b.message, created_at: new Date().toISOString() });
            }
        }
        catch { }
    })();
    return res.status(201).json(t);
});
app.get("/support/tickets", (0, auth_1.requireAuth)(["rider", "driver", "admin"]), (_req, res) => {
    (async () => {
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                const { data, error } = await supabase_1.supabase.from("support_tickets").select("id,user_id,ride_id,category,subject,status").order("created_at", { ascending: false });
                if (error)
                    throw error;
                return res.json({ items: (data || []).map((d) => ({ id: d.id, userId: d.user_id ?? undefined, rideId: d.ride_id ?? undefined, category: d.category, subject: d.subject, status: d.status, messages: [] })) });
            }
            catch { }
        }
        return res.json({ items: Array.from(tickets.values()).sort((a, b) => a.id < b.id ? 1 : -1) });
    })();
});
app.post("/support/tickets/:id/reply", (0, auth_1.requireAuth)(["rider", "driver", "admin"]), (req, res) => {
    const t = tickets.get(req.params.id);
    const b = (req.body ?? {});
    if (!b.text)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    if (t) {
        t.messages.push({ at: new Date().toISOString(), from: (b.from ?? "user"), text: b.text });
        if (b.status)
            t.status = b.status;
        tickets.set(t.id, t);
    }
    (async () => {
        if (!(0, supabase_1.isSupabaseReady)())
            return;
        try {
            await supabase_1.supabase.from("support_messages").insert({ ticket_id: req.params.id, from_role: b.from ?? "user", text: b.text, created_at: new Date().toISOString() });
            if (b.status)
                await supabase_1.supabase.from("support_tickets").update({ status: b.status }).eq("id", req.params.id);
        }
        catch { }
    })();
    return res.json(t ?? { ok: true });
});
const lostItems = new Map();
app.post("/rides/:id/lost-item", (0, auth_1.requireAuth)(["rider", "admin"]), (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const b = (req.body ?? {});
    if (!b.description)
        return res.status(400).json({ error: { code: "VALIDATION_ERROR" } });
    const li = { id: `lost_${Date.now()}`, rideId: ride.id, description: b.description, status: "reported" };
    lostItems.set(li.id, li);
    (async () => {
        if (!(0, supabase_1.isSupabaseReady)())
            return;
        try {
            await supabase_1.supabase.from("lost_items").insert({ id: li.id, ride_id: li.rideId, description: li.description, status: li.status, created_at: new Date().toISOString() });
        }
        catch { }
    })();
    return res.status(201).json(li);
});
app.get("/lost-item", (0, auth_1.requireAuth)(["admin"]), (_req, res) => {
    (async () => {
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                const { data, error } = await supabase_1.supabase.from("lost_items").select("id,ride_id,description,status").order("created_at", { ascending: false });
                if (error)
                    throw error;
                return res.json({ items: (data || []).map((d) => ({ id: d.id, rideId: d.ride_id, description: d.description, status: d.status })) });
            }
            catch { }
        }
        return res.json({ items: Array.from(lostItems.values()).sort((a, b) => a.id < b.id ? 1 : -1) });
    })();
});
const refunds = new Map();
app.post("/rides/:id/refund", (0, auth_1.requireAuth)(["rider", "admin"]), async (req, res) => {
    const ride = rides.get(req.params.id);
    if (!ride)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const b = (req.body ?? {});
    const id = `rf_${Date.now()}`;
    const rr = { id, rideId: ride.id, amountUsd: b.amountUsd, reason: b.reason, status: "requested" };
    refunds.set(id, rr);
    (async () => {
        if (!(0, supabase_1.isSupabaseReady)())
            return;
        try {
            await supabase_1.supabase.from("refund_requests").insert({ id, ride_id: rr.rideId, amount_usd: rr.amountUsd ?? null, reason: rr.reason ?? null, status: rr.status, created_at: new Date().toISOString() });
        }
        catch { }
    })();
    return res.status(201).json(rr);
});
app.post("/admin/refunds/:id/approve", (0, auth_1.requireAuth)(["admin"]), async (req, res) => {
    const rr = refunds.get(req.params.id);
    if (!rr)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const ride = rides.get(rr.rideId);
    if (!ride || !ride.paymentIntentId)
        return res.status(400).json({ error: { code: "NO_PAYMENT" } });
    try {
        const amount = rr.amountUsd ? Math.max(1, Math.round(rr.amountUsd * 100)) : undefined;
        const refund = await stripe.refunds.create({ payment_intent: ride.paymentIntentId, amount });
        rr.status = "refunded";
        rr.refundId = refund.id;
        refunds.set(rr.id, rr);
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                await supabase_1.supabase.from("refund_requests").update({ status: rr.status, refund_id: rr.refundId }).eq("id", rr.id);
            }
            catch { }
        }
        return res.json(rr);
    }
    catch {
        return res.status(500).json({ error: { code: "STRIPE_REFUND_FAILED" } });
    }
});
app.post("/admin/refunds/:id/reject", (0, auth_1.requireAuth)(["admin"]), (req, res) => {
    const rr = refunds.get(req.params.id);
    if (!rr)
        return res.status(404).json({ error: { code: "NOT_FOUND" } });
    rr.status = "rejected";
    refunds.set(rr.id, rr);
    (async () => { if ((0, supabase_1.isSupabaseReady)()) {
        try {
            await supabase_1.supabase.from("refund_requests").update({ status: rr.status }).eq("id", rr.id);
        }
        catch { }
    } })();
    return res.json(rr);
});
app.get("/admin/refunds", (0, auth_1.requireAuth)(["admin"]), (_req, res) => {
    (async () => {
        if ((0, supabase_1.isSupabaseReady)()) {
            try {
                const { data } = await supabase_1.supabase.from("refund_requests").select("id,ride_id,amount_usd,reason,status,refund_id").order("created_at", { ascending: false });
                return res.json({ items: (data || []).map((d) => ({ id: d.id, rideId: d.ride_id, amountUsd: d.amount_usd ?? undefined, reason: d.reason ?? undefined, status: d.status, refundId: d.refund_id ?? undefined })) });
            }
            catch { }
        }
        return res.json({ items: Array.from(refunds.values()).sort((a, b) => a.id < b.id ? 1 : -1) });
    })();
});
// Server + WS
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server, path: "/ws" });
// Ride rooms
const rideRooms = new Map();
function addSocketToRide(rideId, ws) {
    if (!rideRooms.has(rideId))
        rideRooms.set(rideId, new Set());
    rideRooms.get(rideId).add(ws);
    ws.on("close", () => rideRooms.get(rideId)?.delete(ws));
}
function broadcastToRide(rideId, payload) {
    const room = rideRooms.get(rideId);
    if (!room)
        return;
    const data = JSON.stringify(payload);
    for (const client of room) {
        try {
            client.send(data);
        }
        catch { }
    }
}
wss.on("connection", (socket, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const rideId = url.searchParams.get("rideId");
    if (rideId) {
        addSocketToRide(rideId, socket);
        const snapshot = rides.get(rideId);
        if (snapshot)
            socket.send(JSON.stringify({ type: "ride.snapshot", ride: snapshot }));
    }
    else {
        socket.send(JSON.stringify({ type: "hello", ts: Date.now() }));
    }
    // Generic echo for debugging
    socket.on("message", (data) => {
        try {
            const msg = JSON.parse(String(data));
            socket.send(JSON.stringify({ type: "echo", payload: msg }));
        }
        catch {
            socket.send(JSON.stringify({ type: "error", message: "invalid_json" }));
        }
    });
});
const port = Number(process.env.PORT || 4000);
server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${port}`);
});
// Central error handler (fallback)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    return res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR" } });
});
//# sourceMappingURL=index.js.map