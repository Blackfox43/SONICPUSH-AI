import type { Request, Response, NextFunction } from 'express';
import { getFirebaseConfig, getFirestoreDoc } from './firestoreRest.ts';

export type UserRole = 'SUPER_ADMIN' | 'PROMOTER' | 'ARTIST';

export interface VerifiedFirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  customClaims: Record<string, unknown>;
}

export interface ServerAuthSession {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
  role: UserRole | null;
  isSuperAdmin: boolean;
  isBootstrapAdmin: boolean;
  onboardingCompleted: boolean;
  organizationId: string;
  capabilities: {
    canManageUsers: boolean;
    canManagePackages: boolean;
    canManageClients: boolean;
    canReconcilePayments: boolean;
    canAccessAdminConsole: boolean;
  };
}

export interface AuthenticatedRequest extends Request {
  authSession?: ServerAuthSession;
  rawBody?: Buffer;
}

export function getServerBootstrapAdminEmails(): Set<string> {
  const configured = process.env.BOOTSTRAP_ADMIN_EMAILS || 'emma432cent@gmail.com';
  return new Set(
    configured
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isBootstrapAdminEmail(email: string): boolean {
  if (!email) return false;
  return getServerBootstrapAdminEmails().has(email.trim().toLowerCase());
}

export function parseCustomClaims(rawAttributes: string | undefined): Record<string, unknown> {
  if (!rawAttributes) return {};
  try {
    const parsed = JSON.parse(rawAttributes);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseIdentity> {
  const cfg = getFirebaseConfig();
  const lookupRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${cfg.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!lookupRes.ok) {
    throw new Error('INVALID_TOKEN');
  }

  const data = (await lookupRes.json()) as {
    users?: Array<{
      localId?: string;
      email?: string;
      emailVerified?: boolean;
      disabled?: boolean;
      customAttributes?: string;
    }>;
  };

  const account = data.users?.[0];
  if (!account || !account.localId || account.disabled) {
    throw new Error('INVALID_TOKEN');
  }

  return {
    uid: account.localId,
    email: (account.email || '').trim(),
    emailVerified: Boolean(account.emailVerified),
    customClaims: parseCustomClaims(account.customAttributes),
  };
}

export async function resolveServerSession(
  identity: VerifiedFirebaseIdentity,
  idToken: string
): Promise<ServerAuthSession> {
  const bootstrapEligible = identity.emailVerified && isBootstrapAdminEmail(identity.email);
  const claimSuperAdmin =
    identity.customClaims.superAdmin === true || identity.customClaims.role === 'SUPER_ADMIN';

  let userDoc: Record<string, unknown> | null = null;
  try {
    userDoc = await getFirestoreDoc('users', identity.uid, idToken);
  } catch {
    userDoc = null;
  }

  const storedRole =
    userDoc?.role === 'SUPER_ADMIN' || userDoc?.role === 'PROMOTER' || userDoc?.role === 'ARTIST'
      ? (userDoc.role as UserRole)
      : null;

  let resolvedRole: UserRole | null = storedRole;
  if (claimSuperAdmin || (bootstrapEligible && (!storedRole || storedRole === 'SUPER_ADMIN'))) {
    resolvedRole = 'SUPER_ADMIN';
  }

  const isSuperAdmin = resolvedRole === 'SUPER_ADMIN' || claimSuperAdmin || bootstrapEligible;
  const isPromoterOrAdmin = isSuperAdmin || resolvedRole === 'PROMOTER';

  return {
    uid: identity.uid,
    email: identity.email,
    emailVerified: identity.emailVerified,
    idToken,
    role: resolvedRole,
    isSuperAdmin,
    isBootstrapAdmin: bootstrapEligible,
    onboardingCompleted: Boolean(userDoc?.onboardingCompleted),
    organizationId: typeof userDoc?.organizationId === 'string' ? userDoc.organizationId : '',
    capabilities: {
      canManageUsers: isSuperAdmin,
      canManagePackages: isSuperAdmin,
      canManageClients: isPromoterOrAdmin,
      canReconcilePayments: isSuperAdmin,
      canAccessAdminConsole: isSuperAdmin,
    },
  };
}

export type TokenVerifierFn = (idToken: string) => Promise<VerifiedFirebaseIdentity>;
export type SessionResolverFn = (
  identity: VerifiedFirebaseIdentity,
  idToken: string
) => Promise<ServerAuthSession>;

export function createAuthMiddleware(
  verifier: TokenVerifierFn = verifyFirebaseIdToken,
  resolver: SessionResolverFn = resolveServerSession
) {
  return async function verifyFirebaseAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
      return;
    }

    const idToken = header.slice('Bearer '.length).trim();
    if (!idToken) {
      res.status(401).json({ error: 'Authentication required. Empty token.' });
      return;
    }

    try {
      const identity = await verifier(idToken);
      if (!identity.emailVerified) {
        res.status(403).json({
          error: 'Verified email address is required for SONICPUSH AI operations.',
        });
        return;
      }
      req.authSession = await resolver(identity, idToken);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired authentication session.' });
    }
  };
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const session = req.authSession;
    if (!session) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!session.role || !allowedRoles.includes(session.role)) {
      res.status(403).json({
        error: 'Access denied. Your account role does not permit this operation.',
      });
      return;
    }
    next();
  };
}
