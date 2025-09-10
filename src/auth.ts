import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";

const jwksUrl = process.env.CLERK_JWKS_URL || "";
const issuer = process.env.CLERK_ISSUER || "";
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

export type AuthUser = { sub: string; role?: "rider" | "driver" | "admin" };

export async function verifyJwt(token: string): Promise<AuthUser | null> {
	if (!jwks) return null;
	const { payload } = await jwtVerify(token, jwks, issuer ? { issuer } : {});
	return { sub: String(payload.sub), role: (payload["role"] as any) };
}

export function requireAuth(roles?: Array<AuthUser["role"]>) {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const auth = req.headers.authorization;
			if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
			const token = auth.slice(7);
			const user = await verifyJwt(token);
			if (!user) return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
			if (roles && !roles.includes(user.role)) return res.status(403).json({ error: { code: "FORBIDDEN" } });
			(req as any).user = user;
			return next();
		} catch {
			return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
		}
	};
}

