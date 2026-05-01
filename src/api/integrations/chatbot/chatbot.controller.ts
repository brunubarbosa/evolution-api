import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import {
  difyController,
  evoaiController,
  evolutionBotController,
  flowiseController,
  n8nController,
  openaiController,
  typebotController,
} from '@api/server.module';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import { forensic } from '@forensic/forensic-logger';
import { IntegrationSession } from '@prisma/client';
import { findBotByTrigger } from '@utils/findBotByTrigger';

// 2026-05-01 incident: every messages.upsert fans out to 7 chatbot
// controllers, each issuing 1-3 Prisma findFirst/findMany against its own
// config table (Typebot, Flowise, Dify, EvolutionBot, OpenAI, n8n, Evoai)
// plus FlowiseSetting, DifySetting, etc. With 0 chatbots configured this
// is pure overhead — 9+ queries per message. When 9 of those parked in
// `idle/ClientRead` after an undici `terminated` exception, the entire
// connection pool wedged for 3.6 hours.
//
// Mitigation: cache "any chatbot enabled for this instance?" per
// instanceId and skip the fan-out entirely if cached `false`. Cache TTL
// is short (60s) so a freshly-enabled bot picks up within the next minute.
// On any chatbot create/update the cache for that instance is invalidated
// (see invalidateChatbotEnabledCache below).
const CHATBOT_ENABLED_CACHE_TTL_MS = Number(process.env.CHATBOT_ENABLED_CACHE_TTL_MS) || 60_000;
const chatbotEnabledCache = new Map<string, { enabled: boolean; expiresAt: number }>();

export function invalidateChatbotEnabledCache(instanceId?: string) {
  if (instanceId) chatbotEnabledCache.delete(instanceId);
  else chatbotEnabledCache.clear();
}

export type EmitData = {
  instance: InstanceDto;
  remoteJid: string;
  msg: any;
  pushName?: string;
};

export interface ChatbotControllerInterface {
  integrationEnabled: boolean;
  botRepository: any;
  settingsRepository: any;
  sessionRepository: any;
  userMessageDebounce: { [key: string]: { message: string; timeoutId: NodeJS.Timeout } };

  createBot(instance: InstanceDto, data: any): Promise<any>;
  findBot(instance: InstanceDto): Promise<any>;
  fetchBot(instance: InstanceDto, botId: string): Promise<any>;
  updateBot(instance: InstanceDto, botId: string, data: any): Promise<any>;
  deleteBot(instance: InstanceDto, botId: string): Promise<any>;

  settings(instance: InstanceDto, data: any): Promise<any>;
  fetchSettings(instance: InstanceDto): Promise<any>;

  changeStatus(instance: InstanceDto, botId: string, status: string): Promise<any>;
  fetchSessions(instance: InstanceDto, botId: string, remoteJid?: string): Promise<any>;
  ignoreJid(instance: InstanceDto, data: any): Promise<any>;

  emit(data: EmitData): Promise<void>;
}

export class ChatbotController {
  public prismaRepository: PrismaRepository;
  public waMonitor: WAMonitoringService;

  public readonly logger = new Logger('ChatbotController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    this.prisma = prismaRepository;
    this.monitor = waMonitor;
  }

  public set prisma(prisma: PrismaRepository) {
    this.prismaRepository = prisma;
  }

  public get prisma() {
    return this.prismaRepository;
  }

  public set monitor(waMonitor: WAMonitoringService) {
    this.waMonitor = waMonitor;
  }

  public get monitor() {
    return this.waMonitor;
  }

  private async anyChatbotEnabled(instanceId: string): Promise<boolean> {
    const now = Date.now();
    const cached = chatbotEnabledCache.get(instanceId);
    if (cached && cached.expiresAt > now) return cached.enabled;

    // One small parallel COUNT batch instead of 7+ sequential findFirst calls.
    // Each count uses the existing (instanceId, enabled) covering indexes.
    let enabled = false;
    try {
      const counts = await Promise.all([
        this.prismaRepository.typebot.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.openaiBot.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.evolutionBot.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.dify.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.flowise.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.n8n.count({ where: { instanceId, enabled: true } }),
        this.prismaRepository.evoai.count({ where: { instanceId, enabled: true } }),
      ]);
      enabled = counts.some((c) => c > 0);
    } catch (err) {
      // If any count throws (incl. PrismaTimeoutError), be conservative:
      // assume something is configured and let the per-controller emit
      // path attempt — they each have their own try/catch. We still
      // record the fact so we can correlate with prisma.timeout events.
      forensic({
        kind: 'chatbot.precheck.error',
        instance: instanceId,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      }).catch(() => {});
      enabled = true;
    }

    chatbotEnabledCache.set(instanceId, {
      enabled,
      expiresAt: now + CHATBOT_ENABLED_CACHE_TTL_MS,
    });
    return enabled;
  }

  public async emit({
    instance,
    remoteJid,
    msg,
    pushName,
    isIntegration = false,
  }: {
    instance: InstanceDto;
    remoteJid: string;
    msg: any;
    pushName?: string;
    isIntegration?: boolean;
  }): Promise<void> {
    // Short-circuit: if no chatbot is configured for this instance, skip
    // the entire fan-out. Saves 7+ Prisma queries per inbound message.
    if (instance?.instanceId) {
      const enabled = await this.anyChatbotEnabled(instance.instanceId);
      if (!enabled) return;
    }

    const emitData = {
      instance,
      remoteJid,
      msg,
      pushName,
      isIntegration,
    };
    evolutionBotController.emit(emitData);

    typebotController.emit(emitData);

    openaiController.emit(emitData);

    difyController.emit(emitData);

    n8nController.emit(emitData);

    evoaiController.emit(emitData);

    flowiseController.emit(emitData);
  }

  public processDebounce(
    userMessageDebounce: any,
    content: string,
    remoteJid: string,
    debounceTime: number,
    callback: any,
  ) {
    if (userMessageDebounce[remoteJid]) {
      userMessageDebounce[remoteJid].message += `\n${content}`;
      this.logger.log('message debounced: ' + userMessageDebounce[remoteJid].message);
      clearTimeout(userMessageDebounce[remoteJid].timeoutId);
    } else {
      userMessageDebounce[remoteJid] = {
        message: content,
        timeoutId: null,
      };
    }

    userMessageDebounce[remoteJid].timeoutId = setTimeout(() => {
      const myQuestion = userMessageDebounce[remoteJid].message;
      this.logger.log('Debounce complete. Processing message: ' + myQuestion);

      delete userMessageDebounce[remoteJid];
      callback(myQuestion);
    }, debounceTime * 1000);
  }

  public checkIgnoreJids(ignoreJids: any, remoteJid: string) {
    if (ignoreJids && ignoreJids.length > 0) {
      let ignoreGroups = false;
      let ignoreContacts = false;

      if (ignoreJids.includes('@g.us')) {
        ignoreGroups = true;
      }

      if (ignoreJids.includes('@s.whatsapp.net')) {
        ignoreContacts = true;
      }

      if (ignoreGroups && remoteJid.endsWith('@g.us')) {
        this.logger.warn('Ignoring message from group: ' + remoteJid);
        return true;
      }

      if (ignoreContacts && remoteJid.endsWith('@s.whatsapp.net')) {
        this.logger.warn('Ignoring message from contact: ' + remoteJid);
        return true;
      }

      if (ignoreJids.includes(remoteJid)) {
        this.logger.warn('Ignoring message from jid: ' + remoteJid);
        return true;
      }

      return false;
    }

    return false;
  }

  public async getSession(remoteJid: string, instance: InstanceDto) {
    let session = await this.prismaRepository.integrationSession.findFirst({
      where: {
        remoteJid: remoteJid,
        instanceId: instance.instanceId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (session) {
      if (session.status !== 'closed' && !session.botId) {
        this.logger.warn('Session is already opened in another integration');
        return null;
      } else if (!session.botId) {
        session = null;
      }
    }

    return session;
  }

  public async findBotTrigger(
    botRepository: any,
    content: string,
    instance: InstanceDto,
    session?: IntegrationSession,
  ) {
    let findBot: any = null;

    if (!session) {
      findBot = await findBotByTrigger(botRepository, content, instance.instanceId);

      if (!findBot) {
        return null;
      }
    } else {
      findBot = await botRepository.findFirst({
        where: {
          id: session.botId,
        },
      });
    }

    return findBot;
  }
}
