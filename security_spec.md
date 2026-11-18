# SONICPUSH AI — Firestore Security Specification

## 1. Data Invariants
1. **Verified Identity**: All database writes and reads require `request.auth != null` and `request.auth.token.email_verified == true` (except `test/connection` health probe).
2. **No Self-Escalation**: A user creating `users/{uid}` may only choose `ARTIST` or `PROMOTER`. Only the bootstrapped admin email or an existing `SUPER_ADMIN` can hold or grant `SUPER_ADMIN`.
3. **Immutable Ownership & Tenant Scope**: `ownerId`, `organizationId`, and `createdAt` cannot be modified after creation.
4. **Server Timestamps**: `createdAt == request.time` on creation and `updatedAt == request.time` on updates.
5. **Organization & Assignment Isolation**: `list` queries never delegate filtering to the client; rules enforce `resource.data.ownerId == request.auth.uid || request.auth.uid in resource.data.assignedUserIds || isBootstrappedAdmin()`.
6. **Terminal State Locking**: Paid/void invoices, verified payments, and completed campaigns cannot be mutated by non-admins once in terminal state.
7. **PII Isolation**: User records with email PII can only be read by the owner or `SUPER_ADMIN`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Role Self-Escalation on Create**: Creating `/users/attackerUid` with `role: "SUPER_ADMIN"` as a non-admin email -> `PERMISSION_DENIED`.
2. **Role Self-Escalation on Update**: Updating own `/users/uid` changing `role` from `"ARTIST"` to `"PROMOTER"` or `"SUPER_ADMIN"` -> `PERMISSION_DENIED`.
3. **Cross-Tenant Org Spoofing**: Creating `/artists/a1` with `organizationId` belonging to another org or omitting `ownerId == request.auth.uid` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection**: Updating `/campaigns/c1` with an extra undeclared field `isFeatured: true` -> `PERMISSION_DENIED` (`hasOnly` + `isValidCampaign`).
5. **Unverified Email Spoof**: Request with `email_verified: false` claiming admin email -> `PERMISSION_DENIED`.
6. **Blanket List Scraping**: Listing `/artists` or `/clients` without matching `ownerId`/`assignedUserIds` -> `PERMISSION_DENIED`.
7. **ID Poisoning**: Creating `/songs/../../etc/passwd` or 200-char ID -> `PERMISSION_DENIED` (`isValidId`).
8. **Timestamp Forgery**: Creating `/campaigns/c1` with backdated `createdAt` != `request.time` -> `PERMISSION_DENIED`.
9. **Terminal Invoice Tampering**: Non-admin modifying `amount` on an invoice with `status: "paid"` -> `PERMISSION_DENIED`.
10. **Payment Verification Forgery**: Non-admin updating `/payments/p1` setting `verificationStatus: "verified"` -> `PERMISSION_DENIED`.
11. **Service Package Price Tampering**: Artist/Promoter updating `/service_packages/STARTER` -> `PERMISSION_DENIED`.
12. **PII Blanket Read**: Authenticated User A reading `/users/userB` -> `PERMISSION_DENIED`.
