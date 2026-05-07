// [GDW-007] Community DTOs — REST surface for Baileys' communities.* methods.
// Style mirrors `src/api/dto/group.dto.ts` (plain TS classes, no Zod).

export class CommunityJid {
  communityJid: string;
}

export class CommunityCreateDto {
  subject: string;
  body: string;
}

export class CommunityCreateGroupDto {
  subject: string;
  participants: string[];
  parentCommunityJid: string;
}

export class CommunitySubjectDto extends CommunityJid {
  subject: string;
}

export class CommunityDescriptionDto extends CommunityJid {
  description?: string;
}

export class CommunityLinkGroupDto {
  groupJid: string;
  parentCommunityJid: string;
}

export class CommunityInviteCode {
  inviteCode: string;
}

export class CommunityAcceptInviteV4Dto {
  // Either a remote-jid string or a full WAMessageKey shape.
  key: string | { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  // proto.Message.IGroupInviteMessage shape — accept loosely; baileys validates.
  inviteMessage: Record<string, unknown>;
}

export class CommunityRevokeInviteV4Dto extends CommunityJid {
  invitedJid: string;
}

export class CommunityUpdatePendingRequestsDto extends CommunityJid {
  participants: string[];
  action: 'approve' | 'reject';
}

export class CommunityUpdateParticipantsDto extends CommunityJid {
  participants: string[];
  action: 'add' | 'remove' | 'promote' | 'demote';
}
