"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyJwt = verifyJwt;
exports.requireAuth = requireAuth;
const jose_1 = require("jose");
const jwksUrl = process.env.CLERK_JWKS_URL || "";
const issuer = process.env.CLERK_ISSUER || "";
const jwks = jwksUrl ? (0, jose_1.createRemoteJWKSet)(new URL(jwksUrl)) : null;
async function verifyJwt(token) {
    if (!jwks)
        return null;
    const { payload } = await (0, jose_1.jwtVerify)(token, jwks, issuer ? { issuer } : {});
    return { sub: String(payload.sub), role: payload["role"] };
}
function requireAuth(roles) {
    return async (req, res, next) => {
        try {
            if (process.env.TEST_BYPASS_AUTH === "true") {
                const roleHeader = req.headers["x-test-role"];
                const role = roleHeader || undefined;
                req.user = { sub: "test", role: role || "admin" };
                if (roles && role && !roles.includes(role))
                    return res.status(403).json({ error: { code: "FORBIDDEN" } });
                return next();
            }
            const auth = req.headers.authorization;
            if (!auth?.startsWith("Bearer "))
                return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
            const token = auth.slice(7);
            const user = await verifyJwt(token);
            if (!user)
                return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
            if (roles && !roles.includes(user.role))
                return res.status(403).json({ error: { code: "FORBIDDEN" } });
            req.user = user;
            return next();
        }
        catch {
            return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
        }
    };
}
//# sourceMappingURL=auth.js.map