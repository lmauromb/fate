import type { AnyTRPCProcedure } from '@trpc/server';
import { ObjectId } from 'mongodb';
import type { AggregateOptions, Db, Document, Filter } from 'mongodb';
import { isRecord } from '../record.ts';
import type { AnyRecord } from '../types.ts';
import { resolveConnection, withConnection } from './connection.ts';
import { attachComputedState, type DataView } from './dataView.ts';
import {
  createSourceRegistry,
  resolveSourceById,
  resolveSourceByIds,
  resolveSourceConnection,
} from './executor.ts';
import {
  createSourceDefinitions,
  createSourcePlan,
  type SourceConfig,
  type SourceDefinition,
  type SourcePlan,
  type SourcePlanNode,
  type SourceOrder,
} from './source.ts';
import { bindSourceProcedures } from './sourceRouter.ts';

export type MongoDBRelation = {
  /** Embedded document/array storage path. Embedded entities must have stable IDs. */
  embedded?: string;
  foreignKey: string;
  /** Public field names. Arrays of references work on either side. */
  localKey: string;
  orderBy?: SourceOrder;
  /** Explicit link collection for many-to-many references. Keys are storage names. */
  through?: { collection: string; foreignKey: string; localKey: string };
  /** Target view, required for a count-only relation absent from the public view. */
  view?: DataView<AnyRecord>;
};

export type MongoDBViewConfig<Context = unknown, Item extends AnyRecord = AnyRecord> = Omit<
  SourceConfig<Item>,
  'relations'
> & {
  collection: string;
  /** Public-to-storage mapping. id maps to _id by default. */
  fields?: Record<string, string>;
  /** ObjectId by default; string IDs must be explicitly configured. */
  idType?: 'objectId' | 'string';
  relations?: Record<string, MongoDBRelation>;
  /** Server-owned filter, applied to root reads, relations, counts, and cursor lookups. */
  where?: (options: { args?: AnyRecord; ctx: Context }) => Filter<Document>;
};

export type MongoDBQueryExtra = {
  /** Native MongoDB filter using storage names and BSON values. Never pass raw client input. */
  where?: Filter<Document>;
};

export type MongoDBSourceAdapterOptions<Context> = {
  db: Db | ((ctx: Context) => Db);
  /** Use this to propagate request/transaction sessions and query timeouts. */
  options?: (ctx: Context) => AggregateOptions;
  views: Array<MongoDBViewConfig<Context>>;
};

type Source = SourceDefinition<AnyRecord>;
type Node<Context> = SourcePlanNode<Context>;
type Input = { args?: AnyRecord; select: Iterable<string> };
type Read<Context, Item extends AnyRecord> = {
  ctx: Context;
  extra?: MongoDBQueryExtra;
  plan: SourcePlan<Item, Context>;
};
type Page = { cursor?: string; direction: 'forward' | 'backward'; skip?: number; take: number };
type Compiled = { hydrate: (row: Document) => AnyRecord; stages: Array<Document> };

/** Convert BSON ObjectIds at the transport boundary without changing Date values. */
const normalize = (entry: unknown): unknown => {
  // BSON identity requires the driver class, not a structural user-object check.
  // oxlint-disable-next-line @nkzw/no-instanceof
  if (entry instanceof ObjectId) {
    return entry.toHexString();
  }
  if (Array.isArray(entry)) {
    return entry.map(normalize);
  }
  if (isRecord(entry) && Object.getPrototypeOf(entry) === Object.prototype) {
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, normalize(item)]));
  }
  return entry;
};
export function mongoDBRecord(value: Document): AnyRecord {
  return normalize(value) as AnyRecord;
}

const atPath = (value: Document, path: string): unknown =>
  path.split('.').reduce<unknown>((item, key) => (isRecord(item) ? item[key] : undefined), value);

const sourceOf = (source: Source | (() => Source)) =>
  typeof source === 'function' ? source() : source;
const and = (...filters: Array<Document | undefined>): Document => {
  const present = filters.filter((filter): filter is Document =>
    Boolean(filter && Object.keys(filter).length),
  );
  return present.length ? { $and: present } : {};
};
const safePath = (path: string) => {
  if (
    !path ||
    path
      .split('.')
      .some(
        (part) =>
          !part || part.startsWith('$') || ['__proto__', 'prototype', 'constructor'].includes(part),
      )
  ) {
    throw new Error(`Invalid MongoDB field path: ${path}`);
  }
  return path;
};
const asArray = (expression: unknown) => ({
  $cond: [
    { $isArray: expression },
    expression,
    { $cond: [{ $eq: [{ $ifNull: [expression, null] }, null] }, [], [expression]] },
  ],
});
const matches = (left: unknown, right: unknown) => ({
  $gt: [{ $size: { $setIntersection: [asArray(left), asArray(right)] } }, 0],
});

export function createMongoDBSourceAdapter<Context = unknown>({
  db,
  options,
  views,
}: MongoDBSourceAdapterOptions<Context>) {
  const configs = views.map((config) => ({
    ...config,
    id: config.id ?? 'id',
    orderBy: config.orderBy ?? [{ direction: 'desc' as const, field: config.id ?? 'id' }],
  }));
  const sources = createSourceDefinitions(
    configs.map(({ relations: _relations, ...config }) => config),
    {
      resolveRelation: ({ config, field }) => {
        const relation = configs.find((entry) => entry.view.fields === config.view.fields)
          ?.relations?.[field];
        if (!relation) {
          throw new Error(
            `MongoDB relation ${config.view.typeName}.${field} requires explicit metadata.`,
          );
        }
        return relation;
      },
    },
  );
  const getSource = <Item extends AnyRecord>(
    target: DataView<Item> | SourceDefinition<Item>,
  ): SourceDefinition<Item> => {
    const view = 'view' in target ? target.view : target;
    const found = sources.find((source) => source.view.fields === view.fields);
    if (!found) {
      throw new Error(`No MongoDB source registered for ${view.typeName}.`);
    }
    return found as SourceDefinition<Item>;
  };
  const configOf = (source: Source) => configs[sources.indexOf(source)]!;
  const storage = (source: Source, field: string): string => {
    const config = configOf(source);
    const [head, ...tail] = safePath(field).split('.');
    return safePath(
      [config.fields?.[head] ?? (head === config.id ? '_id' : head), ...tail].join('.'),
    );
  };
  const parseId = (source: Source, value: string) => {
    if (configOf(source).idType === 'string') {
      return value;
    }
    if (!/^[a-f\d]{24}$/i.test(value)) {
      throw new Error('MongoDB IDs and cursors must be 24-character ObjectId hex strings.');
    }
    return new ObjectId(value);
  };
  const getDb = (ctx: Context) => (typeof db === 'function' ? db(ctx) : db);
  const filter = (source: Source, ctx: Context, args?: AnyRecord) =>
    configOf(source).where?.({ args, ctx });

  // Count-only references do not need to expose the related collection in the view.
  for (const [index, config] of configs.entries()) {
    for (const [field, relation] of Object.entries(config.relations ?? {})) {
      if (sources[index].relations?.[field]) {
        continue;
      }
      if (!relation.view) {
        throw new Error(
          `Count-only MongoDB relation ${config.view.typeName}.${field} requires a view.`,
        );
      }
      sources[index].relations ??= {};
      sources[index].relations[field] = relation.through
        ? { ...relation, kind: 'manyToMany', source: getSource(relation.view) }
        : { ...relation, kind: 'many', source: getSource(relation.view), through: undefined };
    }
  }

  const compile = async (
    node: Node<Context>,
    ctx: Context,
    extra?: MongoDBQueryExtra,
    page?: Page,
    dependencies: Array<string> = [],
  ): Promise<Compiled> => {
    const source = node.source;
    const config = configOf(source);
    const stages: Array<Document> = [{ $match: and(filter(source, ctx, node.args), extra?.where) }];
    const projection: Document = { _id: 0 };
    const fieldPaths = new Set([...node.selectedFields, source.id]);
    const relations = new Map(node.relations);
    const hidden = new Map<string, Array<string>>();
    const countHydrators: Array<(row: Document, result: AnyRecord) => void> = [];
    const relationHydrators: Array<(row: Document, result: AnyRecord) => void> = [];
    let sequence = 0;
    const temporaryFields = new Set<string>();
    const temporary = () => {
      let name: string;
      do {
        name = `__fate_mongodb_${sequence++}`;
      } while (name in source.view.fields);
      temporaryFields.add(name);
      return name;
    };

    const dependency = (path: string) => {
      const [head, ...tail] = path.split('.');
      if (source.relations?.[head] && tail.length) {
        hidden.set(head, [...(hidden.get(head) ?? []), tail.join('.')]);
      } else {
        fieldPaths.add(path);
      }
    };
    for (const path of dependencies) {
      dependency(path);
    }
    for (const computed of node.computeds.values()) {
      for (const selection of Object.values(computed.select ?? {})) {
        if (selection.kind === 'field') {
          dependency(selection.path);
        }
      }
    }
    const resolverCounts: Array<{ relation: string; where?: Document }> = [];
    for (const resolver of node.resolvers.values()) {
      const selection =
        typeof resolver.select === 'function'
          ? resolver.select({ args: node.args, context: ctx })
          : resolver.select;
      const walk = (value: AnyRecord, prefix = '') => {
        for (const [key, selected] of Object.entries(value)) {
          if (key === '_count' && isRecord(selected) && isRecord(selected.select)) {
            if (prefix) {
              throw new Error(
                'Define nested MongoDB counts as computed fields on the related view.',
              );
            }
            for (const [relation, setting] of Object.entries(selected.select)) {
              if (setting) {
                resolverCounts.push({
                  relation,
                  where: isRecord(setting) ? (setting.where as Document) : undefined,
                });
              }
            }
          } else if (selected === true) {
            dependency(prefix + key);
          } else if (isRecord(selected) && isRecord(selected.select)) {
            if (Object.keys(selected).some((option) => option !== 'select')) {
              throw new Error(
                'MongoDB resolver dependencies accept select only; put relation filters in the source where callback.',
              );
            }
            walk(selected.select, `${prefix}${key}.`);
          } else if (selected) {
            throw new Error(
              'MongoDB resolver dependencies must use field: true or nested select objects.',
            );
          }
        }
      };
      if (selection) {
        walk(selection);
      }
    }
    for (const [field, paths] of hidden) {
      if (!relations.has(field)) {
        const relation = source.relations![field];
        relations.set(
          field,
          createSourcePlan({ ctx, select: [], source: sourceOf(relation.source) }).root,
        );
      }
      hidden.set(field, paths);
    }

    if (page) {
      if (!Number.isSafeInteger(page.take) || page.take <= 0) {
        throw new Error('MongoDB page size must be a positive integer.');
      }
      if (page.cursor) {
        const id = parseId(source, page.cursor);
        const idOnly = node.orderBy.length === 1 && node.orderBy[0].field === source.id;
        const anchor = idOnly
          ? { [storage(source, source.id)]: id }
          : await getDb(ctx)
              .collection(config.collection)
              .findOne(
                and(filter(source, ctx, node.args), extra?.where, {
                  [storage(source, source.id)]: id,
                }),
                {
                  ...options?.(ctx),
                  projection: Object.fromEntries(
                    node.orderBy.map(({ field }) => [storage(source, field), 1]),
                  ),
                },
              );
        if (!anchor) {
          throw new Error('MongoDB cursor record is missing or inaccessible for this ordering.');
        }
        stages.push({
          $match: {
            $or: node.orderBy.map((entry, index) => {
              const path = storage(source, entry.field);
              const value = atPath(anchor, path) ?? null;
              const greater = (entry.direction === 'asc') === (page.direction === 'forward');
              // MongoDB sort places missing/null before non-null scalar values.
              const comparison = greater
                ? value === null
                  ? { [path]: { $ne: null } }
                  : { [path]: { $gt: value } }
                : value === null
                  ? { $expr: false }
                  : { $or: [{ [path]: { $lt: value } }, { [path]: null }] };
              return and(
                ...node.orderBy.slice(0, index).map(({ field }) => ({
                  [storage(source, field)]: atPath(anchor, storage(source, field)) ?? null,
                })),
                comparison,
              );
            }),
          },
        });
      }
      stages.push({
        $sort: Object.fromEntries(
          node.orderBy.map(({ direction, field }) => [
            storage(source, field),
            (direction === 'asc' ? 1 : -1) * (page.direction === 'backward' ? -1 : 1),
          ]),
        ),
      });
      // fate's skip: 1 denotes exclusion of the cursor, already expressed by strict ranges.
      const skip = Math.max(0, (page.skip ?? 0) - (page.cursor ? 1 : 0));
      if (skip) {
        stages.push({ $skip: skip });
      }
      stages.push({ $limit: page.take });
    } else {
      stages.push({
        $sort: Object.fromEntries(
          node.orderBy.map(({ direction, field }) => [
            storage(source, field),
            direction === 'asc' ? 1 : -1,
          ]),
        ),
      });
    }

    const lookup = (field: string, childStages: Array<Document>, alias: string) => {
      const relation = source.relations?.[field];
      const metadata = config.relations?.[field];
      if (!relation || !metadata) {
        throw new Error(`Missing MongoDB relation ${source.view.typeName}.${field}.`);
      }
      const target = sourceOf(relation.source);
      const targetConfig = configOf(target);
      let from: string | undefined = targetConfig.collection;
      let pipeline: Array<Document>;
      if (metadata.embedded) {
        from = undefined;
        pipeline = [{ $documents: '$$embedded' }, ...childStages];
      } else if (metadata.through) {
        from = metadata.through.collection;
        pipeline = [
          { $match: { $expr: matches(`$${safePath(metadata.through.localKey)}`, '$$local') } },
          {
            $lookup: {
              as: '__target',
              from: targetConfig.collection,
              let: { target: `$${safePath(metadata.through.foreignKey)}` },
              pipeline: [
                {
                  $match: {
                    $expr: matches(`$${storage(target, relation.foreignKey)}`, '$$target'),
                  },
                },
              ],
            },
          },
          { $unwind: '$__target' },
          { $replaceWith: '$__target' },
          { $group: { _id: `$${storage(target, target.id)}`, document: { $first: '$$ROOT' } } },
          { $replaceWith: '$document' },
          ...childStages,
        ];
      } else {
        pipeline = [
          { $match: { $expr: { $gt: [{ $size: asArray('$$local') }, 0] } } },
          ...childStages,
        ];
      }
      stages.push({
        $lookup: {
          as: alias,
          ...(from ? { from } : {}),
          ...(!metadata.embedded && !metadata.through
            ? {
                foreignField: storage(target, relation.foreignKey),
                localField: storage(source, relation.localKey),
              }
            : {}),
          let: metadata.embedded
            ? { embedded: asArray(`$${safePath(metadata.embedded)}`) }
            : { local: `$${storage(source, relation.localKey)}` },
          pipeline,
        },
      });
      projection[alias] = 1;
    };

    for (const [field, childNode] of relations) {
      const relation = source.relations![field];
      const many = relation.kind !== 'one';
      let childPage: Page | undefined;
      if (many) {
        // Reuse fate's validation and connection conventions, including the lookahead row.
        await resolveConnection({
          ctx,
          input: { args: childNode.args, select: [] },
          query: async (requested) => {
            childPage = requested;
            return [];
          },
        });
      }
      if (
        config.relations?.[field]?.embedded &&
        childPage?.cursor &&
        childNode.orderBy.some(({ field }) => field !== childNode.source.id)
      ) {
        throw new Error('Embedded MongoDB cursor pagination requires ordering by the embedded ID.');
      }
      const child = await compile(childNode, ctx, undefined, childPage, hidden.get(field));
      const alias = temporary();
      lookup(field, many ? child.stages : [...child.stages, { $limit: 1 }], alias);
      relationHydrators.push((row, result) => {
        const children = (row[alias] as Array<Document>).map(child.hydrate);
        if (childPage?.direction === 'backward') {
          children.reverse();
        }
        if (childPage) {
          const size = childPage.take - 1;
          const more = children.length > size;
          const limited =
            childPage.direction === 'backward' ? children.slice(-size) : children.slice(0, size);
          result[field] = {
            items: limited.map((item) => ({ cursor: String(item.id), node: item })),
            pagination: {
              hasNext: childPage.direction === 'backward' ? Boolean(childPage.cursor) : more,
              hasPrevious: childPage.direction === 'backward' ? more : Boolean(childPage.cursor),
              nextCursor: limited.at(-1)?.id,
              previousCursor: (
                childPage.direction === 'backward' ? more : Boolean(childPage.cursor)
              )
                ? limited[0]?.id
                : undefined,
            },
          };
        } else {
          result[field] = many ? children : (children[0] ?? null);
        }
      });
    }
    const addCount = (
      relationName: string,
      where: unknown,
      attach: (result: AnyRecord, count: number) => void,
    ) => {
      const relation = source.relations?.[relationName];
      if (!relation || relation.kind === 'one') {
        throw new Error(`MongoDB count requires a collection relation: ${relationName}.`);
      }
      if (where !== undefined && (!isRecord(where) || 'getSQL' in where)) {
        throw new Error('MongoDB count filters must be native MongoDB filter objects.');
      }
      const alias = temporary();
      const target = sourceOf(relation.source);
      lookup(
        relationName,
        [{ $match: and(filter(target, ctx), where as Document | undefined) }, { $count: 'value' }],
        alias,
      );
      countHydrators.push((row, result) => attach(result, row[alias][0]?.value ?? 0));
    };
    for (const [field, computed] of node.computeds) {
      for (const [name, selection] of Object.entries(computed.select ?? {})) {
        if (selection.kind === 'count') {
          addCount(selection.relation, selection.where, (result, count) =>
            attachComputedState(result, field, { [name]: count }),
          );
        }
      }
    }
    for (const { relation, where } of resolverCounts) {
      addCount(relation, where, (result, count) => {
        result._count = { ...(result._count as AnyRecord), [relation]: count };
      });
    }
    for (const field of fieldPaths) {
      if (
        field !== 'cursor' &&
        !relations.has(field) &&
        ![...fieldPaths].some((parent) => field.startsWith(`${parent}.`))
      ) {
        projection[safePath(field)] = `$${storage(source, field)}`;
      }
    }
    stages.push({ $project: projection });
    return {
      hydrate: (row) => {
        const result = mongoDBRecord(
          Object.fromEntries(Object.entries(row).filter(([key]) => !temporaryFields.has(key))),
        );
        if (source.id !== 'id') {
          result.id = result[source.id];
        }
        for (const hydrate of relationHydrators) {
          hydrate(row, result);
        }
        for (const hydrate of countHydrators) {
          hydrate(row, result);
        }
        return result;
      },
      stages,
    };
  };

  const execute = async <Item extends AnyRecord>(
    { ctx, extra, plan }: Read<Context, Item>,
    page?: Page,
  ) => {
    const compiled = await compile(plan.root, ctx, extra, page);
    const rows = await getDb(ctx)
      .collection(configOf(plan.source).collection)
      .aggregate(compiled.stages, options?.(ctx))
      .toArray();
    const items = rows.map(compiled.hydrate);
    return (page?.direction === 'backward' ? items.reverse() : items) as Array<Item>;
  };
  const fetchByIds = async <Item extends AnyRecord>({
    ids,
    ...read
  }: Read<Context, Item> & { ids: Array<string> }) => {
    if (!ids.length) {
      return [];
    }
    const source = read.plan.source;
    const values = ids.map((id) => parseId(source, id));
    const items = await execute({
      ...read,
      extra: { where: and(read.extra?.where, { [storage(source, source.id)]: { $in: values } }) },
    });
    const byId = new Map(items.map((item) => [String(item.id), item]));
    return values.flatMap((value) => {
      const item = byId.get(String(value));
      return item ? [item] : [];
    });
  };
  const fetchById = async <Item extends AnyRecord>({
    id,
    ...read
  }: Read<Context, Item> & { id: string }) => (await fetchByIds({ ...read, ids: [id] }))[0] ?? null;
  const fetchConnection = <Item extends AnyRecord>({
    cursor,
    direction,
    skip,
    take,
    ...read
  }: Read<Context, Item> & Page) => execute(read, { cursor, direction, skip, take });
  const registry = createSourceRegistry<Context>(
    sources.map((source) => [
      source,
      {
        byId: (input) => fetchById({ ...input, extra: input.extra as MongoDBQueryExtra }),
        byIds: (input) => fetchByIds({ ...input, extra: input.extra as MongoDBQueryExtra }),
        connection: (input) =>
          fetchConnection({ ...input, extra: input.extra as MongoDBQueryExtra }),
      },
    ]),
  );
  type Resolve<Item extends AnyRecord> = {
    ctx: Context;
    extra?: MongoDBQueryExtra;
    input: Input;
    view: DataView<Item>;
  };
  return {
    createPlan: <Item extends AnyRecord>({
      view,
      ...input
    }: Input & { ctx?: Context; view: DataView<Item> }) =>
      createSourcePlan({ ...input, source: getSource(view) }),
    fetchById,
    fetchByIds,
    fetchConnection,
    getSource,
    registry,
    resolveById: <Item extends AnyRecord>({ view, ...input }: Resolve<Item> & { id: string }) =>
      resolveSourceById({ ...input, registry, source: getSource(view) }),
    resolveByIds: <Item extends AnyRecord>({
      view,
      ...input
    }: Resolve<Item> & { ids: Array<string> }) =>
      resolveSourceByIds({ ...input, registry, source: getSource(view) }),
    resolveConnection: <Item extends AnyRecord>({ view, ...input }: Resolve<Item> & Page) =>
      resolveSourceConnection({ ...input, registry, source: getSource(view) }),
  };
}

export type MongoDBSourceAdapter<Context = unknown> = ReturnType<
  typeof createMongoDBSourceAdapter<Context>
>;
export const createMongoDBSourceRegistry = <Context>(
  options: MongoDBSourceAdapterOptions<Context>,
) => createMongoDBSourceAdapter(options).registry;

type ProcedureLike = {
  input: (schema: any) => { query: (resolver: (options: any) => unknown) => AnyTRPCProcedure };
};
export function createMongoDBFate<Context, Procedure extends ProcedureLike>({
  procedure,
  ...options
}: MongoDBSourceAdapterOptions<Context> & { procedure: Procedure }) {
  const adapter = createMongoDBSourceAdapter(options);
  const connection = withConnection(procedure);
  const procedures = bindSourceProcedures<Context, Procedure, typeof connection>({
    createConnectionProcedure: connection,
    procedure,
    registry: adapter.registry,
  });
  return {
    ...adapter,
    connection,
    procedures: <
      Item extends AnyRecord,
      ById extends boolean | undefined = undefined,
      List extends boolean | { defaultSize?: number } | undefined = undefined,
    >(
      input: DataView<Item> | { byId?: ById; list?: List; view: DataView<Item> },
    ) => {
      const value = 'view' in input ? input : { view: input };
      return procedures<Item, ById, List>({ ...value, source: adapter.getSource(value.view) });
    },
  };
}

export { createMongoDBIdempotencyStore } from './mongodbIdempotency.ts';
