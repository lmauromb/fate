import type { LiveConnectionSourceEvent, LiveSourceEvent } from '@nkzw/fate/server';
import { isRecord } from '@nkzw/fate/server';
import type SchemaBuilder from '@pothos/core';
import type { Context, createAPI } from './api.ts';
import { userView, postView, commentView } from './api.ts';
import type { PothosTypes } from './graphql.ts';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const decodeLiveId = (type: string, id: string) => {
  const decoded = { id: id.slice(id.indexOf('-') + 1), typename: id.slice(0, id.indexOf('-')) };
  if (decoded.typename !== type) {
    throw new Error(`Expected '${type}' but received '${decoded.typename}'.`);
  }
  return decoded.id;
};

export function registerLive(
  builder: InstanceType<typeof SchemaBuilder<PothosTypes>>,
  api: ReturnType<typeof createAPI>,
) {
  const { fate, live } = api;
  const viewsByType = { Comment: commentView, Post: postView, User: userView };
  const JSONScalar = 'JSON' as const;
  type ViewType = keyof typeof viewsByType;

  type LiveNodePayload = {
    data?: unknown;
    delete?: boolean;
    id?: string | number;
    select?: Array<string>;
  };

  type LiveConnectionPayload = {
    cursor?: string;
    id?: string | number;
    node?: unknown;
    nodeType?: string;
    targetCursor?: string;
    type: LiveConnectionSourceEvent['type'];
  };

  const asViewType = (type: string): ViewType => {
    if (!Object.hasOwn(viewsByType, type)) {
      throw new Error(`Unknown Fate live type '${type}'.`);
    }
    return type as ViewType;
  };

  async function* entityEvents(type: string, id: string) {
    for await (const [event] of live.subscribe(type, id)) {
      yield event;
    }
  }

  async function* connectionEvents(procedure: string, args: Record<string, unknown> | undefined) {
    for await (const [event] of live.subscribeConnection({ args, procedure })) {
      yield event;
    }
  }

  const resolveNodePayload = async ({
    args,
    context,
    event,
    select,
    type,
  }: {
    args?: Record<string, unknown>;
    context: Context;
    event: LiveSourceEvent;
    select: Array<string>;
    type: string;
  }): Promise<LiveNodePayload> => {
    if (event.type === 'delete') {
      return {
        delete: true,
        id: event.id,
      };
    }

    const viewType = asViewType(type);
    const eventSelect = event.changed?.filter((path) => select.includes(path));
    const liveSelect = eventSelect?.length ? eventSelect : select;
    const data = await fate.resolveById({
      ctx: context,
      id: String(event.id),
      input: {
        args,
        select: liveSelect,
      },
      view: viewsByType[viewType],
    });

    return {
      data,
      id: event.id,
      select: liveSelect,
    };
  };

  const resolveConnectionPayload = async ({
    context,
    event,
    select,
    selectionArgs,
    type,
  }: {
    context: Context;
    event: LiveConnectionSourceEvent;
    select: Array<string>;
    selectionArgs?: Record<string, unknown>;
    type: string;
  }): Promise<LiveConnectionPayload> => {
    if (event.type === 'invalidate') {
      return { type: event.type };
    }

    if (event.type === 'deleteEdge') {
      return {
        id: event.id,
        nodeType: event.nodeType ?? type,
        type: event.type,
      };
    }

    const nodeType = asViewType(event.nodeType ?? type);
    const node =
      event.id == null
        ? null
        : await fate.resolveById({
            ctx: context,
            id: String(event.id),
            input: {
              args: selectionArgs,
              select,
            },
            view: viewsByType[nodeType],
          });

    return {
      cursor: event.cursor,
      id: event.id,
      node,
      nodeType,
      targetCursor: event.targetCursor,
      type: event.type,
    };
  };

  builder.subscriptionType();
  const FateLiveNodeEvent = builder.objectRef<LiveNodePayload>('FateLiveNodeEvent').implement({
    fields: (t) => ({
      data: t.field({
        nullable: true,
        resolve: (event) => event.data,
        type: JSONScalar,
      }),
      delete: t.boolean({
        nullable: true,
        resolve: (event) => event.delete,
      }),
      id: t.string({
        nullable: true,
        resolve: (event) => (event.id == null ? null : String(event.id)),
      }),
      select: t.field({
        nullable: true,
        resolve: (event) => event.select,
        type: ['String'],
      }),
    }),
  });

  const FateLiveConnectionEvent = builder
    .objectRef<LiveConnectionPayload>('FateLiveConnectionEvent')
    .implement({
      fields: (t) => ({
        cursor: t.string({
          nullable: true,
          resolve: (event) => event.cursor,
        }),
        id: t.string({
          nullable: true,
          resolve: (event) => (event.id == null ? null : String(event.id)),
        }),
        node: t.field({
          nullable: true,
          resolve: (event) => event.node,
          type: JSONScalar,
        }),
        nodeType: t.string({
          nullable: true,
          resolve: (event) => event.nodeType,
        }),
        targetCursor: t.string({
          nullable: true,
          resolve: (event) => event.targetCursor,
        }),
        type: t.string({
          nullable: false,
          resolve: (event) => event.type,
        }),
      }),
    });

  builder.subscriptionFields((t) => ({
    fateLiveConnection: t.field({
      args: {
        args: t.arg({ type: JSONScalar }),
        procedure: t.arg.string({ required: true }),
        select: t.arg({ required: true, type: ['String'] }),
        selectionArgs: t.arg({ type: JSONScalar }),
        type: t.arg.string({ required: true }),
      },
      resolve: (event, { select, selectionArgs, type }, context) =>
        resolveConnectionPayload({
          context,
          event: event as LiveConnectionSourceEvent,
          select,
          selectionArgs: asRecord(selectionArgs),
          type,
        }),
      subscribe: (_root, { args, procedure }) => connectionEvents(procedure, asRecord(args)),
      type: FateLiveConnectionEvent,
    }),
    fateLiveNode: t.field({
      args: {
        args: t.arg({ type: JSONScalar }),
        id: t.arg.id({ required: true }),
        select: t.arg({ required: true, type: ['String'] }),
        type: t.arg.string({ required: true }),
      },
      resolve: (event, { args, select, type }, context) =>
        resolveNodePayload({
          args: asRecord(args),
          context,
          event: event as LiveSourceEvent,
          select,
          type,
        }),
      subscribe: (_root, { id, type }) => entityEvents(type, decodeLiveId(type, String(id))),
      type: FateLiveNodeEvent,
    }),
  }));
}
