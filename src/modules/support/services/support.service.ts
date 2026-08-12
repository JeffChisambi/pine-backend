import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  SupportAuthorType,
  SupportTicketCategory,
  SupportTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import {
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import {
  CreateSupportTicketDto,
  ListSupportTicketsQueryDto,
  ReplySupportTicketDto,
} from '../dto/support.dto';

const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface AttachmentInput {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * SupportService — customer "Report a problem" tickets and the staff inbox.
 *
 * A ticket is an append-only thread of messages (customer, staff, or system).
 * Two denormalised flags drive the unread indicators without extra queries:
 *   - awaitingAdmin: newest message is from the customer → dashboard badge
 *   - awaitingUser:  newest message is from staff/system → mobile dot
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ── Customer (mobile) ─────────────────────────────────────────────────────

  async createTicket(
    userId: string,
    dto: CreateSupportTicketDto,
    attachment?: AttachmentInput,
  ) {
    const attachmentKey = attachment
      ? await this.storeAttachment(userId, attachment)
      : null;

    const reference = await this.generateReference();

    const ticket = await this.prisma.supportTicket.create({
      data: {
        reference,
        userId,
        category: dto.category,
        subject: dto.subject.trim(),
        status: SupportTicketStatus.OPEN,
        relatedTransactionId: dto.relatedTransactionId ?? null,
        awaitingAdmin: true,
        awaitingUser: false,
        lastMessageAt: new Date(),
        messages: {
          create: {
            authorType: SupportAuthorType.USER,
            authorId: userId,
            body: dto.message.trim(),
            attachmentKey,
          },
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });

    this.logger.log({ userId, ticketId: ticket.id, reference }, 'Support ticket opened');
    return this.formatThread(ticket, ticket.messages);
  }

  async listUserTickets(userId: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return tickets.map((t) => this.formatSummary(t, t.messages[0]));
  }

  async getUserThread(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) throw new ResourceNotFoundException('Support ticket', ticketId);

    // Opening the thread clears the customer's unread indicator.
    if (ticket.awaitingUser) {
      await this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { awaitingUser: false },
      });
      ticket.awaitingUser = false;
    }

    return this.formatThread(ticket, ticket.messages);
  }

  async addUserMessage(
    userId: string,
    ticketId: string,
    dto: ReplySupportTicketDto,
    attachment?: AttachmentInput,
  ) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
    });
    if (!ticket) throw new ResourceNotFoundException('Support ticket', ticketId);

    const attachmentKey = attachment
      ? await this.storeAttachment(userId, attachment)
      : null;

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: SupportAuthorType.USER,
          authorId: userId,
          body: dto.message.trim(),
          attachmentKey,
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          awaitingAdmin: true,
          awaitingUser: false,
          lastMessageAt: new Date(),
          // A customer reply reopens a resolved/closed ticket.
          status:
            ticket.status === SupportTicketStatus.RESOLVED ||
            ticket.status === SupportTicketStatus.CLOSED
              ? SupportTicketStatus.OPEN
              : ticket.status,
        },
      }),
    ]);

    return this.getUserThread(userId, ticket.id);
  }

  // ── Admin (dashboard) ─────────────────────────────────────────────────────

  async listAdmin(query: ListSupportTicketsQueryDto, scopeBrokerId?: string) {
    const where: Prisma.SupportTicketWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.awaitingAdmin) where.awaitingAdmin = true;
    // Broker isolation: broker admins only see their own investors' tickets.
    if (scopeBrokerId) where.user = { brokerId: scopeBrokerId };

    const limit = Math.min(query.limit ?? 30, 100);
    const page = query.page ?? 1;

    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ awaitingAdmin: 'desc' }, { lastMessageAt: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          user: { select: { id: true, firstName: true, lastName: true, phone: true } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return {
      tickets: tickets.map((t) => ({
        ...this.formatSummary(t, t.messages[0]),
        user: t.user
          ? {
              id: t.user.id,
              name: `${t.user.firstName} ${t.user.lastName}`.trim(),
              phone: t.user.phone,
            }
          : null,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getAdminThread(ticketId: string, scopeBrokerId?: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
      },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
      },
    });
    if (!ticket) throw new ResourceNotFoundException('Support ticket', ticketId);

    const thread = await this.formatThread(ticket, ticket.messages);
    return {
      ...thread,
      user: ticket.user
        ? {
            id: ticket.user.id,
            name: `${ticket.user.firstName} ${ticket.user.lastName}`.trim(),
            phone: ticket.user.phone,
            email: ticket.user.email,
          }
        : null,
    };
  }

  async adminReply(adminId: string, ticketId: string, dto: ReplySupportTicketDto, scopeBrokerId?: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
      },
    });
    if (!ticket) throw new ResourceNotFoundException('Support ticket', ticketId);

    const adminName = await this.resolveStaffName(adminId);

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: SupportAuthorType.ADMIN,
          authorId: adminId,
          authorName: adminName,
          body: dto.message.trim(),
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          awaitingAdmin: false,
          awaitingUser: true,
          lastMessageAt: new Date(),
          // First staff reply moves an OPEN ticket into review.
          status:
            ticket.status === SupportTicketStatus.OPEN
              ? SupportTicketStatus.IN_REVIEW
              : ticket.status,
        },
      }),
    ]);

    await this.notifyUser(
      ticket.userId,
      'Support replied to your report',
      `${adminName} replied to "${ticket.subject}" (${ticket.reference}).`,
      ticket,
    );

    return this.getAdminThread(ticket.id);
  }

  async updateStatus(adminId: string, ticketId: string, status: SupportTicketStatus, scopeBrokerId?: string) {
    void adminId;
    const ticket = await this.prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
      },
    });
    if (!ticket) throw new ResourceNotFoundException('Support ticket', ticketId);

    if (ticket.status === status) return this.getAdminThread(ticket.id);

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: SupportAuthorType.SYSTEM,
          body: `Status changed to ${this.statusLabel(status)}`,
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status,
          awaitingUser: true,
          lastMessageAt: new Date(),
        },
      }),
    ]);

    await this.notifyUser(
      ticket.userId,
      'Your report was updated',
      `"${ticket.subject}" (${ticket.reference}) is now ${this.statusLabel(status)}.`,
      ticket,
    );

    return this.getAdminThread(ticket.id);
  }

  /** Counts for the dashboard sidebar badge / overview. */
  async stats(scopeBrokerId?: string) {
    const brokerFilter = scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {};
    const [awaiting, open, inReview] = await Promise.all([
      this.prisma.supportTicket.count({ where: { awaitingAdmin: true, status: { not: SupportTicketStatus.CLOSED }, ...brokerFilter } }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.OPEN, ...brokerFilter } }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.IN_REVIEW, ...brokerFilter } }),
    ]);
    return { awaitingAdmin: awaiting, open, inReview };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async storeAttachment(userId: string, attachment: AttachmentInput): Promise<string> {
    const ext = ALLOWED_ATTACHMENT_TYPES[attachment.mimeType];
    if (!ext) {
      throw new ValidationException(
        `Unsupported attachment type ${attachment.mimeType}. Use JPEG, PNG, WebP, GIF or PDF.`,
      );
    }
    if (attachment.buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new ValidationException('Attachment exceeds the 5 MB limit.');
    }
    const { key } = await this.storage.upload({
      bucket: 'reports',
      keyPrefix: `support/${userId}`,
      fileName: `${randomUUID()}.${ext}`,
      contentType: attachment.mimeType,
      body: attachment.buffer,
    });
    return key;
  }

  private async attachmentUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    try {
      return await this.storage.getSignedDownloadUrl('reports', key);
    } catch {
      return null;
    }
  }

  /** Display name for a staff member, shown as the message author (e.g. "Chikondi"). */
  private async resolveStaffName(adminId: string): Promise<string> {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { firstName: true, lastName: true },
    });
    if (!admin) return 'Support';
    const name = `${admin.firstName} ${admin.lastName}`.trim();
    return name.length > 0 ? name : 'Support';
  }

  private async generateReference(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const ref = `PN-${Math.floor(1000 + Math.random() * 9000)}`;
      const existing = await this.prisma.supportTicket.findUnique({
        where: { reference: ref },
        select: { id: true },
      });
      if (!existing) return ref;
    }
    // Extremely unlikely fallback — guaranteed-unique long form.
    return `PN-${Date.now().toString().slice(-6)}`;
  }

  private async notifyUser(
    userId: string,
    title: string,
    body: string,
    ticket: { id: string; reference: string },
  ) {
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          channel: 'IN_APP',
          type: 'INFORMATIONAL',
          priority: 2,
          category: 'SYSTEM',
          title,
          body,
          status: 'SENT',
          sentAt: new Date(),
          data: { type: 'SUPPORT_UPDATE', ticketId: ticket.id, reference: ticket.reference },
        },
      });
    } catch (err) {
      // Never let a notification failure break the support flow.
      this.logger.warn({ userId, err }, 'Failed to create support notification');
    }
  }

  private statusLabel(status: SupportTicketStatus): string {
    switch (status) {
      case SupportTicketStatus.OPEN:
        return 'Open';
      case SupportTicketStatus.IN_REVIEW:
        return 'In review';
      case SupportTicketStatus.RESOLVED:
        return 'Resolved';
      case SupportTicketStatus.CLOSED:
        return 'Closed';
      default:
        return status;
    }
  }

  private formatSummary(
    ticket: {
      id: string;
      reference: string;
      category: SupportTicketCategory;
      subject: string;
      status: SupportTicketStatus;
      awaitingUser: boolean;
      awaitingAdmin: boolean;
      relatedTransactionId: string | null;
      lastMessageAt: Date;
      createdAt: Date;
    },
    lastMessage?: { authorType: SupportAuthorType; authorName: string | null; body: string; createdAt: Date },
  ) {
    return {
      ticketId: ticket.id,
      reference: ticket.reference,
      category: ticket.category,
      subject: ticket.subject,
      status: ticket.status,
      statusLabel: this.statusLabel(ticket.status),
      unread: ticket.awaitingUser,
      awaitingAdmin: ticket.awaitingAdmin,
      relatedTransactionId: ticket.relatedTransactionId,
      lastMessageAt: ticket.lastMessageAt,
      createdAt: ticket.createdAt,
      lastMessage: lastMessage
        ? {
            authorType: lastMessage.authorType,
            authorName: lastMessage.authorName,
            preview: lastMessage.body.slice(0, 140),
            createdAt: lastMessage.createdAt,
          }
        : null,
    };
  }

  private async formatThread(
    ticket: {
      id: string;
      reference: string;
      category: SupportTicketCategory;
      subject: string;
      status: SupportTicketStatus;
      awaitingUser: boolean;
      awaitingAdmin: boolean;
      relatedTransactionId: string | null;
      lastMessageAt: Date;
      createdAt: Date;
    },
    messages: Array<{
      id: string;
      authorType: SupportAuthorType;
      authorId: string | null;
      authorName: string | null;
      body: string;
      attachmentKey: string | null;
      createdAt: Date;
    }>,
  ) {
    const formattedMessages = await Promise.all(
      messages.map(async (m) => ({
        id: m.id,
        authorType: m.authorType,
        authorName: m.authorName,
        body: m.body,
        attachmentUrl: await this.attachmentUrl(m.attachmentKey),
        createdAt: m.createdAt,
      })),
    );

    return {
      ticketId: ticket.id,
      reference: ticket.reference,
      category: ticket.category,
      subject: ticket.subject,
      status: ticket.status,
      statusLabel: this.statusLabel(ticket.status),
      unread: ticket.awaitingUser,
      awaitingAdmin: ticket.awaitingAdmin,
      relatedTransactionId: ticket.relatedTransactionId,
      createdAt: ticket.createdAt,
      lastMessageAt: ticket.lastMessageAt,
      messages: formattedMessages,
    };
  }
}
