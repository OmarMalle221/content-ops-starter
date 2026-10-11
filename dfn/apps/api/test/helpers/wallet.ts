import { expect } from 'vitest';
import { Client, PASSWORD, registerUser, type TestContext } from './app';

export interface WalletActors {
  owner: Client;
  ownerUser: any;
  /** Personal workspace of the owner (created at registration). */
  personalOrgId: string;
  /** Business organisation owned by `owner`, with `viewer` as VIEWER. */
  businessOrgId: string;
  viewer: Client;
  viewerUser: any;
  /** A user who is a member of none of the above organisations. */
  outsider: Client;
  outsiderUser: any;
  outsiderOrgId: string;
}

/** Owner + business org + VIEWER member + an unrelated tenant. */
export async function createWalletActors(ctx: TestContext, suffix = ''): Promise<WalletActors> {
  const o = await registerUser(ctx, `wallet-owner${suffix}@example.com`, {
    firstName: 'Fatou',
    lastName: 'Sow',
    country: 'CA',
  });
  const personalOrgId = o.user.organizations[0].id as string;
  const org = await o.client.post('/v1/organizations', {
    name: `Teranga Import${suffix}`,
    country: 'SN',
    legalName: 'Teranga Import SARL',
    registrationNumber: 'SN-DKR-2022-B-4567',
  });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const businessOrgId = org.body.id as string;

  const viewerEmail = `wallet-viewer${suffix}@example.com`;
  const invite = await o.client.post(`/v1/organizations/${businessOrgId}/members/invite`, {
    email: viewerEmail,
    role: 'VIEWER',
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const v = await registerUser(ctx, viewerEmail, { firstName: 'Ibrahima', lastName: 'Fall', country: 'SN' });
  const joined = await v.client.post('/v1/organizations/invitations/accept', { token: invite.body.token });
  expect(joined.status, JSON.stringify(joined.body)).toBe(201);
  await v.client.post('/v1/auth/login', { email: viewerEmail, password: PASSWORD });

  const x = await registerUser(ctx, `wallet-outsider${suffix}@example.com`, {
    firstName: 'Jean',
    lastName: 'Tremblay',
    country: 'CA',
  });
  return {
    owner: o.client,
    ownerUser: o.user,
    personalOrgId,
    businessOrgId,
    viewer: v.client,
    viewerUser: v.user,
    outsider: x.client,
    outsiderUser: x.user,
    outsiderOrgId: x.user.organizations[0].id as string,
  };
}

export const BANK_BENEFICIARY = {
  name: 'Awa Diop',
  country: 'SN',
  currencyCode: 'XOF',
  method: 'BANK_ACCOUNT',
  accountIdentifier: 'SN08 SN01 0152 0000 0012 3456 7890',
  institutionName: 'CBAO Groupe Attijariwafa bank',
  email: 'awa.diop@example.com',
};

export const MOMO_BENEFICIARY = {
  name: 'Mamadou Ba',
  country: 'SN',
  currencyCode: 'XOF',
  method: 'MOBILE_MONEY',
  accountIdentifier: '+221771234567',
  institutionName: 'Wave',
  phone: '+221771234567',
};

/** PUT with the client's cookie jar (the shared Client has no put method). */
export function put(ctx: TestContext, client: Client, url: string, body?: unknown) {
  const cookie = (client as unknown as { cookie: string }).cookie;
  let r = ctx.http().put(url);
  if (cookie) r = r.set('Cookie', cookie);
  return r.send(body ?? {});
}

export async function selfDeposit(
  client: Client,
  organizationId: string,
  currencyCode: string,
  amount: string,
  idempotencyKey?: string,
) {
  return client.post('/v1/sandbox/wallets/self-deposit', {
    organizationId,
    currencyCode,
    amount,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}
