import {
  ComponentResourceOptions,
  Output,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import type { Input } from "../input";
import { FunctionArgs, FunctionArn } from "./function";
import { hashStringToPrettyString, logicalName } from "../naming";
import { parseDynamoStreamArn } from "./helpers/arn";
import { DynamoLambdaSubscriber } from "./dynamo-lambda-subscriber";
import { dynamodb, lambda } from "@pulumi/aws";
import { permission } from "./permission";

export interface DynamoArgs {
  /**
   * An object defining the fields of the table that'll be used to create indexes. The key is the name of the field and the value is the type.
   *
   * :::note
   * You don't need to define all your fields here, just the ones you want to use for indexes.
   * :::
   *
   * While you can have fields field types other than `string`, `number`, and `binary`; you can only use these types for your indexes.
   *
   * @example
   * ```js
   * {
   *   fields: {
   *     userId: "string",
   *     noteId: "string"
   *   }
   * }
   * ```
   */
  fields: Input<Record<string, "string" | "number" | "binary">>;
  /**
   * Define the table's primary index. You can only have one primary index.
   *
   * @example
   * ```js
   * {
   *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" }
   * }
   * ```
   */
  primaryIndex: Input<{
    /**
     * The hash key field of the index. This field needs to be defined in the `fields`.
     */
    hashKey: Input<string>;
    /**
     * The range key field of the index. This field needs to be defined in the `fields`.
     */
    rangeKey?: Input<string>;
  }>;
  /**
   * Configure the table's global secondary indexes.
   *
   * You can have up to 20 global secondary indexes per table. And each global secondary index should have a unique name.
   *
   * @example
   *
   * ```js
   * {
   *   globalIndexes: {
   *     CreatedAtIndex: { hashKey: "userId", rangeKey: "createdAt" }
   *   }
   * }
   * ```
   */
  globalIndexes?: Input<
    Record<
      string,
      Input<{
        /**
         * The hash key field of the index. This field needs to be defined in the `fields`.
         */
        hashKey: Input<string>;
        /**
         * The range key field of the index. This field needs to be defined in the `fields`.
         */
        rangeKey?: Input<string>;
        /**
         * The fields to project into the index.
         * @default `"all"`
         * @example
         * Project only the key fields: `userId` and `createdAt`.
         * ```js
         * {
         *   hashKey: "userId",
         *   rangeKey: "createdAt",
         *   projection: "keys-only"
         * }
         * ```
         *
         * Project the `noteId` field in addition to the key fields.
         * ```js
         * {
         *   hashKey: "userId",
         *   rangeKey: "createdAt",
         *   projection: ["noteId"]
         * }
         * ```
         */
        projection?: Input<"all" | "keys-only" | Input<string>[]>;
      }>
    >
  >;
  /**
   * Configure the table's local secondary indexes.
   *
   * Unlike global indexes, local indexes use the same `hashKey` as the `primaryIndex` of the table.
   *
   * You can have up to 5 local secondary indexes per table. And each local secondary index should have a unique name.
   *
   * @example
   * ```js
   * {
   *   localIndexes: {
   *     CreatedAtIndex: { rangeKey: "createdAt" }
   *   }
   * }
   * ```
   */
  localIndexes?: Input<
    Record<
      string,
      Input<{
        /**
         * The range key field of the index. This field needs to be defined in the `fields`.
         */
        rangeKey: Input<string>;
        /**
         * The fields to project into the index.
         * @default `"all"`
         * @example
         * Project only the key field: `createdAt`.
         * ```js
         * {
         *   rangeKey: "createdAt",
         *   projection: "keys-only"
         * }
         * ```
         *
         * Project the `noteId` field in addition to the key field.
         * ```js
         * {
         *   rangeKey: "createdAt",
         *   projection: ["noteId"]
         * }
         * ```
         */
        projection?: Input<"all" | "keys-only" | Input<string>[]>;
      }>
    >
  >;
  /**
   * Enable [DynamoDB Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html) for the table.
   *
   * :::note
   * Streams are not enabled by default since there's a cost attached to storing them.
   * :::
   *
   * When an item in the table is modified, the stream captures the information and sends it to your subscriber function.
   *
   * :::tip
   * The `new-and-old-images` stream type is a good default option since it has both the new and old items.
   * :::
   *
   * You can configure what will be written to the stream:
   *
   * - `new-image`: The entire item after it was modified.
   * - `old-image`: The entire item before it was modified.
   * - `new-and-old-images`:	Both the new and the old items. A good default to use since it contains all the data.
   * - `keys-only`: Only the keys of the fields of the modified items. If you are worried about the costs, you can use this since it stores the least amount of data.
   * @default Disabled
   * @example
   * ```js
   * {
   *   stream: "new-and-old-images"
   * }
   * ```
   */
  stream?: Input<
    "keys-only" | "new-image" | "old-image" | "new-and-old-images"
  >;
  /**
   * The field in the table to store the _Time to Live_ or TTL timestamp in. This field should
   * be of type `number`. When the TTL timestamp is reached, the item will be deleted.
   *
   * Read more about [Time to Live](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).
   *
   * @example
   * Here the TTL field in our table is called `expireAt`.
   * ```js
   * {
   *   ttl: "expireAt"
   * }
   * ```
   */
  ttl?: Input<string>;
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the DynamoDB Table resource.
     */
    table?: Transform<dynamodb.TableArgs>;
  };
}

export interface DynamoSubscriberArgs {
  /**
   * Filter the records processed by the `subscriber` function.
   *
   * :::tip
   * You can pass in up to 5 different filters.
   * :::
   *
   * You can pass in up to 5 different filter policies. These will logically ORed together. Meaning that if any single policy matches, the record will be processed.
   *
   * :::tip
   * Learn more about the [filter rule syntax](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html#filtering-syntax).
   * :::
   *
   * @example
   * For example, if your DynamoDB table's stream contains the follow record.
   * ```js
   * {
   *   eventID: "1",
   *   eventVersion: "1.0",
   *   dynamodb: {
   *     ApproximateCreationDateTime: "1678831218.0",
   *     Keys: {
   *       CustomerName: {
   *           "S": "AnyCompany Industries"
   *       },
   *       NewImage: {
   *         AccountManager: {
   *           S: "Pat Candella"
   *         },
   *         PaymentTerms: {
   *           S: "60 days"
   *         },
   *         CustomerName: {
   *           S: "AnyCompany Industries"
   *         }
   *       },
   *       SequenceNumber: "111",
   *       SizeBytes: 26,
   *       StreamViewType: "NEW_IMAGE"
   *     }
   *   }
   * }
   * ```
   *
   * To process only those records where the `CustomerName` is `AnyCompany Industries`.

   * ```js
   * {
   *   filters: [
   *     {
   *       dynamodb: {
   *         Keys: {
   *           CustomerName: {
   *             S: ["AnyCompany Industries"]
   *           }
   *         }
   *       }
   *     }
   *   ]
   * }
   * ```
   */
  filters?: Input<Input<Record<string, any>>[]>;
  /**
   * [Transform](/docs/components#transform) how this subscription creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the Lambda Event Source Mapping resource.
     */
    eventSourceMapping?: Transform<lambda.EventSourceMappingArgs>;
  };
}

/**
 * The `Dynamo` component lets you add an [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) table to your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const table = new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string"
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" }
 * });
 * ```
 *
 * #### Add a global index
 *
 * Optionally add a global index to the table.
 *
 * ```ts {8-10} title="sst.config.ts"
 * new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string",
 *     createdAt: "number",
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   globalIndexes: {
 *     CreatedAtIndex: { hashKey: "userId", rangeKey: "createdAt" }
 *   }
 * });
 * ```
 *
 * #### Add a local index
 *
 * Optionally add a local index to the table.
 *
 * ```ts {8-10} title="sst.config.ts"
 * new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string",
 *     createdAt: "number",
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   localIndexes: {
 *     CreatedAtIndex: { rangeKey: "createdAt" }
 *   }
 * });
 * ```
 *
 * #### Subscribe to a DynamoDB Stream
 *
 * To subscribe to a [DynamoDB Stream](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html), start by enabling it.
 *
 * ```ts {7} title="sst.config.ts"
 * const table = new sst.aws.Dynamo("MyTable", {
 *   fields: {
 *     userId: "string",
 *     noteId: "string"
 *   },
 *   primaryIndex: { hashKey: "userId", rangeKey: "noteId" },
 *   stream: "new-and-old-images"
 * });
 * ```
 *
 * Then, subscribing to it.
 *
 * ```ts title="sst.config.ts"
 * table.subscribe("src/subscriber.handler");
 * ```
 *
 * #### Link the table to a resource
 *
 * You can link the table to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [table]
 * });
 * ```
 *
 * Once linked, you can query the table through your app.
 *
 * ```ts title="app/page.tsx" {1,8}
 * import { Resource } from "sst";
 * import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
 * import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
 *
 * const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
 *
 * await client.send(new QueryCommand({
 *   TableName: Resource.MyTable.name,
 *   KeyConditionExpression: "userId = :userId",
 *   ExpressionAttributeValues: {
 *     ":userId": "my-user-id"
 *   }
 * }));
 * ```
 */
export class Dynamo extends Component implements Link.Linkable {
  private constructorName: string;
  private constructorOpts: ComponentResourceOptions;
  private table: Output<dynamodb.Table>;
  private isStreamEnabled: boolean = false;

  constructor(
    name: string,
    args: DynamoArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    const parent = this;

    const table = createTable();

    this.constructorName = name;
    this.constructorOpts = opts;
    this.table = table;
    this.isStreamEnabled = Boolean(args.stream);

    function createTable() {
      return all([
        args.fields,
        args.primaryIndex,
        args.globalIndexes,
        args.localIndexes,
        args.stream,
      ]).apply(
        ([fields, primaryIndex, globalIndexes, localIndexes, stream]) =>
          new dynamodb.Table(
            ...transform(
              args.transform?.table,
              `${name}Table`,
              {
                attributes: Object.entries(fields).map(([name, type]) => ({
                  name,
                  type: type === "string" ? "S" : type === "number" ? "N" : "B",
                })),
                billingMode: "PAY_PER_REQUEST",
                hashKey: primaryIndex.hashKey,
                rangeKey: primaryIndex.rangeKey,
                streamEnabled: Boolean(stream),
                streamViewType: stream
                  ? stream.toUpperCase().replaceAll("-", "_")
                  : undefined,
                pointInTimeRecovery: {
                  enabled: true,
                },
                ttl:
                  args.ttl === undefined
                    ? undefined
                    : {
                        attributeName: args.ttl,
                        enabled: true,
                      },
                globalSecondaryIndexes: Object.entries(globalIndexes ?? {}).map(
                  ([name, index]) => ({
                    name,
                    hashKey: index.hashKey,
                    rangeKey: index.rangeKey,
                    ...(index.projection === "keys-only"
                      ? { projectionType: "KEYS_ONLY" }
                      : Array.isArray(index.projection)
                        ? {
                            projectionType: "INCLUDE",
                            nonKeyAttributes: index.projection,
                          }
                        : { projectionType: "ALL" }),
                  }),
                ),
                localSecondaryIndexes: Object.entries(localIndexes ?? {}).map(
                  ([name, index]) => ({
                    name,
                    rangeKey: index.rangeKey,
                    ...(index.projection === "keys-only"
                      ? { projectionType: "KEYS_ONLY" }
                      : Array.isArray(index.projection)
                        ? {
                            projectionType: "INCLUDE",
                            nonKeyAttributes: index.projection,
                          }
                        : { projectionType: "ALL" }),
                  }),
                ),
              },
              { parent },
            ),
          ),
      );
    }
  }

  /**
   * The ARN of the DynamoDB Table.
   */
  public get arn() {
    return this.table.arn;
  }

  /**
   * The name of the DynamoDB Table.
   */
  public get name() {
    return this.table.name;
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The Amazon DynamoDB Table.
       */
      table: this.table,
    };
  }

  /**
   * Subscribe to the DynamoDB Stream of this table.
   *
   * :::note
   * You'll first need to enable the `stream` before subscribing to it.
   * :::
   *
   * @param subscriber The function that'll be notified.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * table.subscribe("src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("src/subscriber.handler", {
   *   filters: [
   *     {
   *       dynamodb: {
   *         Keys: {
   *           CustomerName: {
   *             S: ["AnyCompany Industries"]
   *           }
   *         }
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * table.subscribe({
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   *
   * Subscribe with an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * table.subscribe("arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   */
  public subscribe(
    subscriber: string | FunctionArgs | FunctionArn,
    args?: DynamoSubscriberArgs,
  ) {
    const sourceName = this.constructorName;

    // Validate stream is enabled
    if (!this.isStreamEnabled)
      throw new Error(
        `Cannot subscribe to "${sourceName}" because stream is not enabled.`,
      );

    return Dynamo._subscribe(
      this.constructorName,
      this.nodes.table.streamArn,
      subscriber,
      args,
      { provider: this.constructorOpts.provider },
    );
  }

  /**
   * Subscribe to the DynamoDB stream of a table that was not created in your app.
   *
   * @param streamArn The ARN of the DynamoDB Stream to subscribe to.
   * @param subscriber The function that'll be notified.
   * @param args Configure the subscription.
   *
   * @example
   *
   * For example, let's say you have a DynamoDB stream ARN of an existing table.
   *
   * ```js title="sst.config.ts"
   * const streamArn = "arn:aws:dynamodb:us-east-1:123456789012:table/MyTable/stream/2024-02-25T23:17:55.264";
   * ```
   *
   * You can subscribe to it by passing in the ARN.
   *
   * ```js title="sst.config.ts"
   * sst.aws.Dynamo.subscribe(streamArn, "src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * sst.aws.Dynamo.subscribe(streamArn, "src/subscriber.handler", {
   *   filters: [
   *     {
   *       dynamodb: {
   *         Keys: {
   *           CustomerName: {
   *             S: ["AnyCompany Industries"]
   *           }
   *         }
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * sst.aws.Dynamo.subscribe(streamArn, {
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   */
  public static subscribe(
    streamArn: Input<string>,
    subscriber: string | FunctionArgs,
    args?: DynamoSubscriberArgs,
  ) {
    return output(streamArn).apply((streamArn) =>
      this._subscribe(
        logicalName(parseDynamoStreamArn(streamArn).tableName),
        streamArn,
        subscriber,
        args,
      ),
    );
  }

  private static _subscribe(
    name: string,
    streamArn: Input<string>,
    subscriber: string | FunctionArgs,
    args: DynamoSubscriberArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    return all([name, subscriber, args]).apply(([name, subscriber, args]) => {
      const suffix = logicalName(
        hashStringToPrettyString(
          [
            streamArn,
            JSON.stringify(args.filters ?? {}),
            typeof subscriber === "string" ? subscriber : subscriber.handler,
          ].join(""),
          6,
        ),
      );

      return new DynamoLambdaSubscriber(
        `${name}Subscriber${suffix}`,
        {
          dynamo: { streamArn },
          subscriber,
          ...args,
        },
        opts,
      );
    });
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        name: this.name,
      },
      include: [
        permission({
          actions: ["dynamodb:*"],
          resources: [this.arn, interpolate`${this.arn}/*`],
        }),
      ],
    };
  }
}

const __pulumiType = "sst:aws:Dynamo";
// @ts-expect-error
Dynamo.__pulumiType = __pulumiType;