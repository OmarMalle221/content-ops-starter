import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import {
  Permission,
  documentMetadataSchema,
  reviewDocumentSchema,
  type DocumentMetadataInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DocumentsService, type UploadedFile as Upload } from './documents.service';

@ApiTags('documents')
@Controller('v1')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
  )
  upload(
    @CurrentUser() auth: AuthContext,
    @UploadedFile() file: Upload,
    @Body(zodBody(documentMetadataSchema)) body: DocumentMetadataInput,
    @Req() req: Request,
  ) {
    return this.documents.upload(auth, file, body, req);
  }

  @Post('transactions/:id/documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
  )
  uploadForTransaction(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Upload,
    @Body(zodBody(documentMetadataSchema.omit({ transactionId: true })))
    body: Omit<DocumentMetadataInput, 'transactionId'>,
    @Req() req: Request,
  ) {
    return this.documents.upload(auth, file, { ...body, transactionId: id }, req);
  }

  @Get('transactions/:id/documents')
  listForTransaction(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listForTransaction(auth, id);
  }

  @Get('documents')
  listMine(@CurrentUser() auth: AuthContext, @Query('organizationId') organizationId?: string) {
    return this.documents.listMine(auth, organizationId || undefined);
  }

  /** Deleted documents and the state of their blob (retained until purge, or purged). */
  @Get('documents/deleted')
  listDeleted(@CurrentUser() auth: AuthContext, @Query('organizationId') organizationId?: string) {
    return this.documents.listDeleted(auth, organizationId || undefined);
  }

  @Get('documents/:id/download')
  async download(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { doc, bytes } = await this.documents.download(auth, id, req);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  }

  @RequirePermission(Permission.ADMIN_VERIFICATIONS)
  @Post('documents/:id/review')
  review(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reviewDocumentSchema)) body: { decision: 'ACCEPT' | 'REJECT'; note?: string },
    @Req() req: Request,
  ) {
    return this.documents.review(auth, id, body.decision, body.note, req);
  }

  @Delete('documents/:id')
  remove(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.documents.softDelete(auth, id, req);
  }
}
