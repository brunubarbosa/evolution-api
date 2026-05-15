import { proto, WAPresence } from 'baileys';

export class Quoted {
  key: proto.IMessageKey;
  message: proto.IMessage;
}

// [GDW-007] Custom link preview override. Baileys accepts a WAUrlInfo
// object on the linkPreview option which lets the sender control the
// title/description/thumbnail of the preview card instead of relying on
// the recipient's WhatsApp client to fetch og: tags. We expose it on
// SendTextDto so GDW can ship user-edited preview cards. The "matched-text"
// field MUST appear verbatim in the message body; otherwise WhatsApp
// drops the preview silently.
export class CustomLinkPreview {
  // The URL substring that appears in the message body. Baileys uses
  // this to locate the preview anchor — typo here = preview dropped.
  'matched-text': string;
  // The final URL the preview points at (after redirects). Can equal
  // matched-text when there's no redirect.
  'canonical-url': string;
  title: string;
  description?: string;
  // Base64-encoded JPEG/PNG bytes (no data: prefix). Optional —
  // omitting it ships a text-only preview card.
  jpegThumbnailBase64?: string;
}

export class Options {
  delay?: number;
  presence?: WAPresence;
  quoted?: Quoted;
  // Backwards-compat: boolean disables (false) or auto-generates (true/undef).
  // Object form ships a fully custom WAUrlInfo preview card.
  linkPreview?: boolean | CustomLinkPreview;
  encoding?: boolean;
  mentionsEveryOne?: boolean;
  mentioned?: string[];
  webhookUrl?: string;
}

export class MediaMessage {
  mediatype: MediaType;
  mimetype?: string;
  caption?: string;
  // for document
  fileName?: string;
  // url or base64
  media: string;
  // wraps the outgoing message in a `viewOnceMessage` envelope so the
  // recipient's WhatsApp client renders it as a one-time-view media bubble
  viewOnce?: boolean;
  // [GDW-006] when mediatype === 'video', render as GIF (autoplay/loop, no audio)
  gifPlayback?: boolean;
}

export class StatusMessage {
  type: string;
  content: string;
  statusJidList?: string[];
  allContacts?: boolean;
  caption?: string;
  backgroundColor?: string;
  font?: number;
}

export class Metadata {
  number: string;
  delay?: number;
  quoted?: Quoted;
  // Backwards-compat: boolean. Object form (see CustomLinkPreview) ships
  // a fully sender-controlled preview card.
  linkPreview?: boolean | CustomLinkPreview;
  mentionsEveryOne?: boolean;
  mentioned?: string[];
  encoding?: boolean;
  notConvertSticker?: boolean;
}

export class SendTextDto extends Metadata {
  text: string;
}
export class SendPresence extends Metadata {
  text: string;
}

export class SendStatusDto extends Metadata {
  type: string;
  content: string;
  statusJidList?: string[];
  allContacts?: boolean;
  caption?: string;
  backgroundColor?: string;
  font?: number;
}

export class SendPollDto extends Metadata {
  name: string;
  selectableCount: number;
  values: string[];
  messageSecret?: Uint8Array;
}

export type MediaType = 'image' | 'document' | 'video' | 'audio' | 'ptv';

export class SendMediaDto extends Metadata {
  mediatype: MediaType;
  mimetype?: string;
  caption?: string;
  // for document
  fileName?: string;
  // url or base64
  media: string;
  viewOnce?: boolean;
}

export class SendPtvDto extends Metadata {
  video: string;
}

export class SendStickerDto extends Metadata {
  sticker: string;
}

export class SendAudioDto extends Metadata {
  audio: string;
}

export type TypeButton = 'reply' | 'copy' | 'url' | 'call' | 'pix';

export type KeyType = 'phone' | 'email' | 'cpf' | 'cnpj' | 'random';

export class Button {
  type: TypeButton;
  displayText?: string;
  id?: string;
  url?: string;
  copyCode?: string;
  phoneNumber?: string;
  currency?: string;
  name?: string;
  keyType?: KeyType;
  key?: string;
}

export class SendButtonsDto extends Metadata {
  thumbnailUrl?: string;
  title: string;
  description?: string;
  footer?: string;
  buttons: Button[];
}

export class SendLocationDto extends Metadata {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

class Row {
  title: string;
  description: string;
  rowId: string;
}
class Section {
  title: string;
  rows: Row[];
}
export class SendListDto extends Metadata {
  title: string;
  description?: string;
  footerText?: string;
  buttonText: string;
  sections: Section[];
}

export class ContactMessage {
  fullName: string;
  wuid: string;
  phoneNumber: string;
  organization?: string;
  email?: string;
  url?: string;
}

export class SendTemplateDto extends Metadata {
  name: string;
  language: string;
  components: any;
  webhookUrl?: string;
}
export class SendContactDto extends Metadata {
  contact: ContactMessage[];
}

export class SendReactionDto {
  key: proto.IMessageKey;
  reaction: string;
}
