import type { Request, Response, NextFunction } from "express";
export type AuthUser = {
    sub: string;
    role?: "rider" | "driver" | "admin";
};
export declare function verifyJwt(token: string): Promise<AuthUser | null>;
export declare function requireAuth(roles?: Array<AuthUser["role"]>): (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
//# sourceMappingURL=auth.d.ts.map