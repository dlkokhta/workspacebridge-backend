import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The match in a snippet is wrapped with these control characters by
 * `ts_headline`. They are non-printable and never occur in real user content,
 * so the frontend can split on them and render the matched run as a <mark>
 * WITHOUT trusting raw HTML (no XSS surface). Keep these in sync with the
 * frontend highlighter.
 */
export const HL_START = String.fromCharCode(1); // U+0001 START OF HEADING
export const HL_END = String.fromCharCode(2); // U+0002 START OF TEXT

const HEADLINE_OPTS = `StartSel=${HL_START},StopSel=${HL_END},MaxFragments=1,MaxWords=16,MinWords=5,ShortWord=2`;

export type SearchResultType =
  | 'message'
  | 'file'
  | 'file_comment'
  | 'shared_task'
  | 'private_task'
  | 'shared_link'
  | 'whiteboard_comment';

export const SEARCH_RESULT_TYPES: SearchResultType[] = [
  'message',
  'file',
  'file_comment',
  'shared_task',
  'private_task',
  'shared_link',
  'whiteboard_comment',
];

interface SearchAuthor {
  id: string;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
}

export interface SearchResult {
  type: SearchResultType;
  /** Id of the matched record. */
  id: string;
  /** Parent record id used for navigation (file id for a file comment,
   *  whiteboard id for a whiteboard comment); undefined when the record is
   *  itself the navigation target. */
  parentId?: string;
  /** Null only for personal private tasks not tied to a workspace. */
  workspaceId: string | null;
  workspaceName: string | null;
  title: string;
  /** Highlighted excerpt; matched runs wrapped in HL_START/HL_END. */
  snippet: string;
  rank: number;
  createdAt: Date;
  author: SearchAuthor | null;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
}

/** Raw column shape every per-source query selects, so one mapper fits all. */
interface RawSearchRow {
  id: string;
  workspaceId: string | null;
  title: string | null;
  snippet: string | null;
  rank: number;
  createdAt: Date;
  authorId: string | null;
  authorFirstname: string | null;
  authorLastname: string | null;
  authorEmail: string | null;
  parentId: string | null;
}

interface SearchParams {
  userId: string;
  role: UserRole;
  /** When set, search is scoped to this single workspace; otherwise it spans
   *  every workspace the user can access (global search). */
  workspaceId?: string;
  q: string;
  types?: SearchResultType[];
  limit: number;
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(params: SearchParams): Promise<SearchResponse> {
    const { userId, role, workspaceId, q, limit } = params;
    const wanted = new Set(
      params.types?.length ? params.types : SEARCH_RESULT_TYPES,
    );

    const workspaces = await this.resolveAccessibleWorkspaces(
      userId,
      workspaceId,
    );
    const workspaceIds = workspaces.map((w) => w.id);
    const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));

    const jobs: Promise<SearchResult[]>[] = [];
    const hasWorkspaces = workspaceIds.length > 0;

    if (hasWorkspaces && wanted.has('message')) {
      jobs.push(this.searchMessages(q, workspaceIds, limit));
    }
    if (hasWorkspaces && wanted.has('file')) {
      jobs.push(this.searchFiles(q, workspaceIds, limit));
    }
    if (hasWorkspaces && wanted.has('file_comment')) {
      jobs.push(this.searchFileComments(q, workspaceIds, limit));
    }
    if (hasWorkspaces && wanted.has('shared_task')) {
      jobs.push(this.searchSharedTasks(q, workspaceIds, limit));
    }
    if (hasWorkspaces && wanted.has('shared_link')) {
      jobs.push(this.searchSharedLinks(q, workspaceIds, limit));
    }
    if (hasWorkspaces && wanted.has('whiteboard_comment')) {
      jobs.push(this.searchWhiteboardComments(q, workspaceIds, limit));
    }
    // Private tasks are personal: only ever the requester's own, and never
    // surfaced to clients (they belong to the freelancer's private workflow).
    if (role !== UserRole.CLIENT && wanted.has('private_task')) {
      jobs.push(this.searchPrivateTasks(q, userId, workspaceId, limit));
    }

    const settled = await Promise.all(jobs);
    const results = settled
      .flat()
      .map((r) => ({
        ...r,
        workspaceName: r.workspaceId
          ? (workspaceNames.get(r.workspaceId) ?? null)
          : null,
      }))
      .sort(
        (a, b) =>
          b.rank - a.rank || b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .slice(0, limit);

    return { query: q, total: results.length, results };
  }

  /**
   * Returns the workspaces the search may read from. For a scoped search this
   * is the single requested workspace (after an owner/member access check);
   * for a global search it is every workspace the user owns or belongs to.
   */
  private async resolveAccessibleWorkspaces(
    userId: string,
    workspaceId?: string,
  ): Promise<{ id: string; name: string }[]> {
    if (workspaceId) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          name: true,
          ownerId: true,
          members: { where: { userId }, select: { id: true } },
        },
      });
      if (!workspace) {
        throw new NotFoundException('Workspace not found');
      }
      const isOwner = workspace.ownerId === userId;
      const isMember = workspace.members.length > 0;
      if (!isOwner && !isMember) {
        throw new ForbiddenException('Not a workspace member');
      }
      return [{ id: workspace.id, name: workspace.name }];
    }

    return this.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { id: true, name: true },
    });
  }

  private async searchMessages(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT m.id::text AS id,
             m.workspace_id::text AS "workspaceId",
             'Message' AS title,
             ts_headline('english', m.content, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', m.content), query) AS rank,
             m.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             NULL::text AS "parentId"
      FROM messages m
      JOIN users u ON u.id = m.sender_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE m.workspace_id IN (${Prisma.join(workspaceIds)})
        AND to_tsvector('english', m.content) @@ query
      ORDER BY rank DESC, m.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('message', rows);
  }

  private async searchFiles(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT f.id::text AS id,
             f.workspace_id::text AS "workspaceId",
             f.name AS title,
             ts_headline('english', f.name, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', f.name), query) AS rank,
             f.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             NULL::text AS "parentId"
      FROM files f
      LEFT JOIN users u ON u.id = f.uploaded_by_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE f.workspace_id IN (${Prisma.join(workspaceIds)})
        AND f.deleted_at IS NULL
        AND to_tsvector('english', f.name) @@ query
      ORDER BY rank DESC, f.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('file', rows);
  }

  private async searchFileComments(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT fc.id::text AS id,
             f.workspace_id::text AS "workspaceId",
             ('Comment on ' || f.name) AS title,
             ts_headline('english', fc.body, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', fc.body), query) AS rank,
             fc.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             f.id::text AS "parentId"
      FROM file_comments fc
      JOIN files f ON f.id = fc.file_id
      LEFT JOIN users u ON u.id = fc.author_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE f.workspace_id IN (${Prisma.join(workspaceIds)})
        AND f.deleted_at IS NULL
        AND to_tsvector('english', fc.body) @@ query
      ORDER BY rank DESC, fc.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('file_comment', rows);
  }

  private async searchSharedTasks(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT st.id::text AS id,
             st.workspace_id::text AS "workspaceId",
             st.title AS title,
             ts_headline('english', st.title, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', st.title), query) AS rank,
             st.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             NULL::text AS "parentId"
      FROM shared_tasks st
      LEFT JOIN users u ON u.id = st.created_by_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE st.workspace_id IN (${Prisma.join(workspaceIds)})
        AND to_tsvector('english', st.title) @@ query
      ORDER BY rank DESC, st.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('shared_task', rows);
  }

  private async searchSharedLinks(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT sl.id::text AS id,
             sl.workspace_id::text AS "workspaceId",
             COALESCE(sl.title, sl.url) AS title,
             ts_headline('english', COALESCE(sl.title, '') || ' ' || sl.url, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', COALESCE(sl.title, '') || ' ' || sl.url), query) AS rank,
             sl.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             NULL::text AS "parentId"
      FROM shared_links sl
      LEFT JOIN users u ON u.id = sl.added_by_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE sl.workspace_id IN (${Prisma.join(workspaceIds)})
        AND to_tsvector('english', COALESCE(sl.title, '') || ' ' || sl.url) @@ query
      ORDER BY rank DESC, sl.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('shared_link', rows);
  }

  private async searchWhiteboardComments(
    q: string,
    workspaceIds: string[],
    limit: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT wc.id::text AS id,
             w.workspace_id::text AS "workspaceId",
             ('Whiteboard: ' || w.name) AS title,
             ts_headline('english', wc.body, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', wc.body), query) AS rank,
             wc.created_at AS "createdAt",
             u.id::text AS "authorId",
             u.firstname AS "authorFirstname",
             u.lastname AS "authorLastname",
             u.email AS "authorEmail",
             w.id::text AS "parentId"
      FROM whiteboard_comments wc
      JOIN whiteboards w ON w.id = wc.whiteboard_id
      JOIN users u ON u.id = wc.author_id,
           websearch_to_tsquery('english', ${q}) query
      WHERE w.workspace_id IN (${Prisma.join(workspaceIds)})
        AND to_tsvector('english', wc.body) @@ query
      ORDER BY rank DESC, wc.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('whiteboard_comment', rows);
  }

  private async searchPrivateTasks(
    q: string,
    userId: string,
    workspaceId: string | undefined,
    limit: number,
  ): Promise<SearchResult[]> {
    // Scoped search restricts to the requested workspace; global search spans
    // all of the user's private tasks (including those with no workspace).
    const workspaceFilter = workspaceId
      ? Prisma.sql`AND pt.workspace_id = ${workspaceId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<RawSearchRow[]>(Prisma.sql`
      SELECT pt.id::text AS id,
             pt.workspace_id::text AS "workspaceId",
             pt.title AS title,
             ts_headline('english', pt.title, query, ${HEADLINE_OPTS}) AS snippet,
             ts_rank(to_tsvector('english', pt.title), query) AS rank,
             pt.created_at AS "createdAt",
             NULL::text AS "authorId",
             NULL::text AS "authorFirstname",
             NULL::text AS "authorLastname",
             NULL::text AS "authorEmail",
             NULL::text AS "parentId"
      FROM private_tasks pt,
           websearch_to_tsquery('english', ${q}) query
      WHERE pt.user_id = ${userId}
        ${workspaceFilter}
        AND to_tsvector('english', pt.title) @@ query
      ORDER BY rank DESC, pt.created_at DESC
      LIMIT ${limit}
    `);
    return this.mapRows('private_task', rows);
  }

  private mapRows(
    type: SearchResultType,
    rows: RawSearchRow[],
  ): SearchResult[] {
    return rows.map((r) => ({
      type,
      id: r.id,
      parentId: r.parentId ?? undefined,
      workspaceId: r.workspaceId,
      workspaceName: null,
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      rank: Number(r.rank),
      createdAt: r.createdAt,
      author: r.authorId
        ? {
            id: r.authorId,
            firstname: r.authorFirstname,
            lastname: r.authorLastname,
            email: r.authorEmail,
          }
        : null,
    }));
  }
}
