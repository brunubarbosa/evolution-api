export class CreateGroupDto {
  subject: string;
  participants: string[];
  description?: string;
  promoteParticipants?: boolean;
}

export class GroupPictureDto {
  groupJid: string;
  image: string;
}

export class GroupSubjectDto {
  groupJid: string;
  subject: string;
}

export class GroupDescriptionDto {
  groupJid: string;
  description: string;
}

export class GroupJid {
  groupJid: string;
}

export class GetParticipant {
  getParticipants: string;
}

export class GroupInvite {
  inviteCode: string;
}

export class AcceptGroupInvite {
  inviteCode: string;
}

export class GroupSendInvite {
  groupJid: string;
  description: string;
  numbers: string[];
}

export class GroupUpdateParticipantDto extends GroupJid {
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
}

export class GroupUpdateSettingDto extends GroupJid {
  action: 'announcement' | 'not_announcement' | 'unlocked' | 'locked';
}

export class GroupToggleEphemeralDto extends GroupJid {
  expiration: 0 | 86400 | 604800 | 7776000;
}

// [GDW-004] Join-request action DTOs — REST surface for the 6 standard
// group RPCs Baileys exposes that upstream Evolution does not wrap.
// Style mirrors the plain-TS-class DTOs above (no Zod).

export class GroupAcceptInviteV4Dto {
  // Either a remote-jid string or a full WAMessageKey shape.
  key: string | { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  // proto.Message.IGroupInviteMessage shape — accept loosely; baileys validates.
  inviteMessage: Record<string, unknown>;
}

export class GroupRevokeInviteV4Dto extends GroupJid {
  invitedJid: string;
}

export class GroupMemberAddModeDto extends GroupJid {
  mode: 'admin_add' | 'all_member_add';
}

export class GroupJoinApprovalModeDto extends GroupJid {
  mode: 'on' | 'off';
}

export class GroupUpdatePendingRequestsDto extends GroupJid {
  participants: string[];
  action: 'approve' | 'reject';
}

// [GDW-008] Query DTO for GET /group/events.
// Always available — even when GDW_PERSIST_GROUP_EVENTS=false the endpoint
// is registered and returns []. See PATCHES.md GDW-008.
export class GroupEventsQueryDto extends GroupJid {
  // Optional ISO-8601 lower bound on createdAt (e.g. "2026-05-03T00:00:00Z").
  since?: string;
  // Optional eventType filter: 'participant_update' | 'join_request' | 'stub:<n>'.
  type?: string;
  // Page size, capped at 500 server-side. Defaults to 100.
  limit?: number;
}
