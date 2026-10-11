import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { FXQuote, PrismaTransactionClient } from '@dfn/database';
import {
  convertMinor,
  createFxRateProvider,
  quoteTransferFee,
  type FxRateProvider,
} from '@dfn/payment-adapters';
import {
  Permission,
  isCorridorSupported,
  minorToDecimalString,
  parseDecimalToMinor,
  type CreateFxQuoteInput,
} from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { moneyDto } from '../../common/serialize';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { toFxQuoteDto } from './transfer.dto';

/**
 * Simulated FX quotes. A quote freezes the (spread-inclusive) sandbox rate and the fee for
 * FX_QUOTE_TTL_MINUTES; a transfer can only be created from a live (QUOTED, unexpired) quote.
 * Nothing here is a market feed and no quote is ever executable against real money.
 */
@Injectable()
export class FxQuotesService {
  private readonly fx: FxRateProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.fx = createFxRateProvider(env.FX_PROVIDER);
  }

  /** Spread of the sandbox provider for display; null when the pair is unknown. */
  private async spreadFor(sourceCurrency: string, destinationCurrency: string): Promise<number | null> {
    try {
      return (await this.fx.getRate(sourceCurrency, destinationCurrency)).spreadBps;
    } catch {
      return null;
    }
  }

  async create(auth: AuthContext, input: CreateFxQuoteInput, req: Request) {
    const membership = this.organizations.resolveActingOrganization(
      auth,
      input.organizationId,
      Permission.TRANSFER_CREATE,
    );
    if (!isCorridorSupported(input.originCountry, input.destinationCountry)) {
      throw new DomainError(
        'CORRIDOR_UNSUPPORTED',
        `Corridor ${input.originCountry} → ${input.destinationCountry} is not open in the sandbox`,
        HttpStatus.BAD_REQUEST,
        { originCountry: input.originCountry, destinationCountry: input.destinationCountry },
      );
    }
    const source = input.sourceCurrency;
    const destination = input.destinationCurrency;
    const sourceAmountMinor = parseDecimalToMinor(input.amount, source);
    if (sourceAmountMinor <= 0n) throw DomainError.validation('Amount must be greater than zero');
    let rate;
    try {
      rate = await this.fx.getRate(source, destination);
    } catch (err) {
      throw DomainError.validation(err instanceof Error ? err.message : 'Unsupported currency pair');
    }
    const fee = quoteTransferFee(sourceAmountMinor, source);
    const destinationAmountMinor = convertMinor(sourceAmountMinor, rate, source, destination);
    if (destinationAmountMinor <= 0n) {
      throw DomainError.validation('Amount is too small to be converted', {
        destination: moneyDto(destinationAmountMinor, destination),
      });
    }
    const expiresAt = new Date(Date.now() + this.env.FX_QUOTE_TTL_MINUTES * 60_000);
    const meta = requestMeta(req);
    const quote = await this.prisma.$transaction(async (db) => {
      const created = await db.fXQuote.create({
        data: {
          organizationId: membership.organizationId,
          createdByUserId: auth.userId,
          originCountry: input.originCountry,
          destinationCountry: input.destinationCountry,
          sourceCurrency: source,
          destinationCurrency: destination,
          sourceAmountMinor,
          rateNumerator: rate.numerator,
          rateDenominator: rate.denominator,
          feeBps: fee.feeBps,
          fixedFeeMinor: fee.fixedFeeMinor,
          feeMinor: fee.feeMinor,
          destinationAmountMinor,
          provider: rate.provider,
          status: 'QUOTED',
          expiresAt,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: membership.organizationId,
          action: 'fx_quote.created',
          entityType: 'FXQuote',
          entityId: created.id,
          metadata: {
            corridor: `${input.originCountry}-${input.destinationCountry}`,
            source: minorToDecimalString(sourceAmountMinor, source),
            sourceCurrency: source,
            destination: minorToDecimalString(destinationAmountMinor, destination),
            destinationCurrency: destination,
            fee: minorToDecimalString(fee.feeMinor, source),
            provider: rate.provider,
            spreadBps: rate.spreadBps,
            expiresAt: expiresAt.toISOString(),
            simulated: true,
          },
          ...meta,
        },
        db,
      );
      return created;
    });
    return toFxQuoteDto(quote, rate.spreadBps);
  }

  /** Loads a quote the caller may see (member of its organisation or staff); otherwise 404. */
  async loadFor(auth: AuthContext, id: string, db: PrismaTransactionClient | PrismaService = this.prisma) {
    const quote = await db.fXQuote.findUnique({ where: { id } });
    if (!quote) throw DomainError.notFound('Quote');
    if (!isStaff(auth) && !membershipFor(auth, quote.organizationId)) throw DomainError.notFound('Quote');
    return this.expireIfStale(quote, db);
  }

  /** Lazy expiry: a QUOTED quote past its validity becomes EXPIRED on read. */
  async expireIfStale(
    quote: FXQuote,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<FXQuote> {
    if (quote.status !== 'QUOTED' || quote.expiresAt > new Date()) return quote;
    const updated = await db.fXQuote.updateMany({
      where: { id: quote.id, status: 'QUOTED' },
      data: { status: 'EXPIRED' },
    });
    return updated.count ? { ...quote, status: 'EXPIRED' } : quote;
  }

  async get(auth: AuthContext, id: string) {
    const quote = await this.loadFor(auth, id);
    return toFxQuoteDto(quote, await this.spreadFor(quote.sourceCurrency, quote.destinationCurrency));
  }
}
