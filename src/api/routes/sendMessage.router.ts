import { RouterBroker } from '@api/abstract/abstract.router';
import {
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTemplateDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import { sendMessageController } from '@api/server.module';
import {
  audioMessageSchema,
  buttonsMessageSchema,
  contactMessageSchema,
  listMessageSchema,
  locationMessageSchema,
  mediaMessageSchema,
  pollMessageSchema,
  ptvMessageSchema,
  reactionMessageSchema,
  statusMessageSchema,
  stickerMessageSchema,
  templateMessageSchema,
  textMessageSchema,
} from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';
import multer from 'multer';

import { emitTraceFireAndForget, mintTraceId, outboundTraceContext, shortHash } from '../../forensic/outbound-trace';
import { HttpStatus } from './index.router';

const upload = multer({ storage: multer.memoryStorage() });

/**
 * Outbound tracer (L2.http): reads `X-GDW-Trace-Id` from the incoming
 * request — or mints one and tags `origin=UNKNOWN` so we can tell if a
 * send arrives from a NON-worker source (rogue cron, leaked apikey, the
 * Chrome extension hitting Evolution directly, etc).
 *
 * Stamps `res.locals.outboundTraceId` so downstream controllers /
 * sendMessageWithTyping can forward it to L3 and L4.
 *
 * Always on — Redis write failures are swallowed inside
 * emitTraceFireAndForget, so a broken Redis can never break a send.
 */
const outboundTraceMiddleware: RequestHandler = (req, res, next) => {
  const headerVal = req.header('x-gdw-trace-id') || req.header('X-GDW-Trace-Id');
  const isMinted = !headerVal;
  const traceId = headerVal || mintTraceId();
  res.locals.outboundTraceId = traceId;
  res.locals.outboundTraceOriginMinted = isMinted;

  // Snapshot enough of the body to identify the caller and message.
  // We deliberately do NOT log apikey value — only its presence + a hash
  // prefix so a leaked-key spree is detectable without storing the secret.
  const body: any = req.body ?? {};
  const apiKey = (req.header('apikey') as string | undefined) || (req.header('Apikey') as string | undefined) || '';
  const text = typeof body.text === 'string' ? body.text : undefined;
  const caption = typeof body.caption === 'string' ? body.caption : undefined;
  const bodyPreview = (text ?? caption ?? '').slice(0, 200);

  emitTraceFireAndForget(traceId, 'L2.http', {
    route: req.originalUrl,
    method: req.method,
    instance: (req.params && (req.params as any).instanceName) || '',
    number: typeof body.number === 'string' ? body.number : '',
    body_hash: shortHash(text ?? caption ?? ''),
    body_preview: bodyPreview,
    has_media: body.media ? '1' : '0',
    mediatype: typeof body.mediatype === 'string' ? body.mediatype : '',
    // origin === 'header' means caller (likely the GDW worker) supplied
    // a trace_id. 'minted' means we minted one because nobody did —
    // i.e. THE CALLER IS UNKNOWN. That's the smoking gun column.
    origin: isMinted ? 'minted' : 'header',
    src_ip: (req.ip || req.socket?.remoteAddress || '').toString(),
    apikey_hash: apiKey ? shortHash(apiKey) : '',
    apikey_len: String(apiKey.length),
    user_agent: (req.header('user-agent') || '').slice(0, 200),
  });

  // Run the rest of the request inside an AsyncLocalStorage context so
  // deep callers (Baileys service, etc.) can read the traceId without
  // having to thread it through every method signature.
  outboundTraceContext.run({ traceId, origin: isMinted ? 'minted' : 'header' }, () => next());
};

export class MessageRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    // Mount the tracer FIRST so it sees the inbound headers/body before any
    // validator-side rejection. If validation throws, the L2.http row is
    // already in the stream — we don't lose the "where did this come from"
    // signal on 4xx requests.
    this.router.use(outboundTraceMiddleware);
    this.router
      .post(this.routerPath('sendTemplate'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendTemplateDto>({
          request: req,
          schema: templateMessageSchema,
          ClassRef: SendTemplateDto,
          execute: (instance, data) => sendMessageController.sendTemplate(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendText'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendTextDto>({
          request: req,
          schema: textMessageSchema,
          ClassRef: SendTextDto,
          execute: (instance, data) => sendMessageController.sendText(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendMedia'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendMediaDto>({
          request: req,
          schema: mediaMessageSchema,
          ClassRef: SendMediaDto,
          execute: (instance) => sendMessageController.sendMedia(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendPtv'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendPtvDto>({
          request: req,
          schema: ptvMessageSchema,
          ClassRef: SendPtvDto,
          execute: (instance) => sendMessageController.sendPtv(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendWhatsAppAudio'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendAudioDto>({
          request: req,
          schema: audioMessageSchema,
          ClassRef: SendMediaDto,
          execute: (instance) => sendMessageController.sendWhatsAppAudio(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      // TODO: Revisar funcionamento do envio de Status
      .post(this.routerPath('sendStatus'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendStatusDto>({
          request: req,
          schema: statusMessageSchema,
          ClassRef: SendStatusDto,
          execute: (instance) => sendMessageController.sendStatus(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendSticker'), ...guards, upload.single('file'), async (req, res) => {
        const bodyData = req.body;

        const response = await this.dataValidate<SendStickerDto>({
          request: req,
          schema: stickerMessageSchema,
          ClassRef: SendStickerDto,
          execute: (instance) => sendMessageController.sendSticker(instance, bodyData, req.file as any),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendLocation'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendLocationDto>({
          request: req,
          schema: locationMessageSchema,
          ClassRef: SendLocationDto,
          execute: (instance, data) => sendMessageController.sendLocation(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendContact'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendContactDto>({
          request: req,
          schema: contactMessageSchema,
          ClassRef: SendContactDto,
          execute: (instance, data) => sendMessageController.sendContact(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendReaction'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendReactionDto>({
          request: req,
          schema: reactionMessageSchema,
          ClassRef: SendReactionDto,
          execute: (instance, data) => sendMessageController.sendReaction(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendPoll'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendPollDto>({
          request: req,
          schema: pollMessageSchema,
          ClassRef: SendPollDto,
          execute: (instance, data) => sendMessageController.sendPoll(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendList'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendListDto>({
          request: req,
          schema: listMessageSchema,
          ClassRef: SendListDto,
          execute: (instance, data) => sendMessageController.sendList(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('sendButtons'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendButtonsDto>({
          request: req,
          schema: buttonsMessageSchema,
          ClassRef: SendButtonsDto,
          execute: (instance, data) => sendMessageController.sendButtons(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      });
  }

  public readonly router: Router = Router();
}
