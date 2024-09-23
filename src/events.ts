import { openDB } from "idb";
import { getGameNumber } from "./intel";
import { post } from "./network";
import { logCount } from "./npaserver";
export const messageCache: { [k: string]: any[] } = {
  game_event: [],
  game_diplomacy: [],
};

export interface Message {
  activity?: string;
  comment_count?: number;
  created: string;
  date: number;
  group?: "game_event" | "game_diplomacy";
  key: string;
  payload?: any;
  status?: "read" | "unread";
  body?: string;
}

interface TypedMessage {
  group: string;
  message: Message;
}

export const messageIndex: { [word: string]: TypedMessage[] } = {};

function dbName(group: string) {
  return `${getGameNumber()}:${group}`;
}
async function store(incoming: any[], group: string) {
  const db = await openDB(dbName(group), 1, {
    upgrade(db) {
      const store = db.createObjectStore(group, {
        keyPath: "key",
      });
      store.createIndex("date", "date", { unique: false });
    },
  });

  const tx = db.transaction(group, "readwrite");
  await Promise.all([
    ...incoming.map(async (x) => {
      if (x?.comment_count === 0) {
        return tx.store.add(x);
      }
      await tx.store.put(x);
      if (x.comment_count) {
        if (x.status === "read") {
          if (messageCache[x.key]?.length === undefined) {
            requestMessageComments(x.comment_count, x.key);
          } else {
            const len = messageCache[x.key].length;
            const delta = x.comment_count - len + 1;
            requestMessageComments(delta, x.key);
          }
        } else {
          console.log(
            `Avoid caching comments for ${x.key} since it is unread: ${x?.payload?.subject}`,
          );
        }
      }
    }),
    tx.done,
  ]);
}
async function restore(group: string) {
  const db = await openDB(dbName(group), 1, {
    upgrade(db) {
      const store = db.createObjectStore(group, {
        keyPath: "key",
      });
      store.createIndex("date", "date", { unique: false });
    },
  });
  return db.getAllFromIndex(group, "date");
}

function indexMessages(group: string, messages: any[]) {
  for (const message of messages) {
    if (message.body || message.payload?.body) {
      const body = message.body || message.payload?.body;
      const tokens = body.split(/[^\w\d]+/);
      for (const token of tokens) {
        if (token) {
          if (messageIndex[token] === undefined) {
            messageIndex[token] = [];
          }
          messageIndex[token].push({ group, message });
        }
      }
    }
  }
}

export async function restoreFromDB(
  group: "game_event" | "game_diplomacy" | string,
) {
  if (messageCache[group]?.length === undefined) {
    messageCache[group] = [];
  }
  if (messageCache[group].length === 0) {
    try {
      messageCache[group] = await restore(group);
      indexMessages(group, messageCache[group]);
      console.log(
        `Restored message cache for ${group} from db: ${messageCache[group].length}`,
      );
      if (group === "game_diplomacy") {
        logCount("loading_diplomacy_from_db");
        for (const message of messageCache[group]) {
          restoreFromDB(message.key);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
}
async function cacheEventResponseCallback(
  group: "game_event" | "game_diplomacy" | string,
  response: { report: { messages: any } },
): Promise<boolean> {
  let incoming = response.report.messages;
  if (incoming === undefined) {
    logCount("incoming_undefined");
    logCount(JSON.stringify(response.report));
    return false;
  }
  incoming = incoming.map((message: Message) => {
    return {
      ...message,
      date: -Date.parse(message?.activity || message.created),
    };
  });
  await restoreFromDB(group);
  if (messageCache[group].length > 0) {
    let overlapOffset = -1;
    let first = 0;
    const len = messageCache[group].length;
    let latest = messageCache[group][first];
    for (let i = 0; i < incoming.length; ++i) {
      const message = incoming[i];
      if (message.key === latest.key) {
        first++;
        const isUnchanged = (message: any, latest: any) => {
          if (
            message.group !== "game_event" &&
            message?.status &&
            message.status !== latest?.status
          ) {
            logCount(
              `status_changed_from_${message.status}_to_${latest.status}`,
            );
            return false;
          }
          const ret = message?.comment_count === latest?.comment_count;
          logCount(`isUnchanged_${ret}`);
          return ret;
        };
        const orig_i = i;
        if (isUnchanged(message, latest) || first >= len) {
          const keys: { [k: string]: boolean } = {};
          for (const m of messageCache[group]) {
            keys[m.key] = true;
          }
          while (i > 0 && incoming[i - 1].created === message.created) {
            const outOfOrderCandidate = incoming[i - 1];
            if (keys[outOfOrderCandidate.key]) {
              i--;
              logCount(`decrement_i_${orig_i - i}`);
              continue;
            }
            break;
          }
          overlapOffset = i;
          let overlapsFound = true;
          for (let j = i; j < incoming.length; ++j) {
            overlapsFound &&= keys[incoming[j].key];
          }
          logCount(`overlaps_found_${overlapsFound}`);
          let collisionsFound = false;
          for (let j = 0; j < i; ++j) {
            collisionsFound ||= keys[incoming[j].key] === true;
          }
          logCount(`collisions_found_${collisionsFound}`);
          break;
        }
        messageCache[group] = messageCache[group].slice(1);
        latest = messageCache[group][0];
        i = 0;
      }
    }
    if (incoming.length > messageCache[group].length) {
      logCount("would_force_restore");
      console.log(`Incoming messages forced restore: ${incoming.length}`);
      const knownKeys: { [k: string]: boolean } = {};
      for (const m of messageCache[group]) {
        knownKeys[m.key] = true;
      }
      const forceIncoming: Message[] = [];
      for (const m of incoming) {
        if (!knownKeys[m.key]) {
          forceIncoming.push(m);
        }
      }
      console.log(`Forcibly adding ${forceIncoming.length} missing keys`);
      logCount(`Force store ${forceIncoming.length}`);
      store(forceIncoming, group);
      messageCache[group] = forceIncoming.concat(messageCache[group]);
      logCount(`Force messageCache len ${messageCache[group].length}`);
    }
    if (overlapOffset >= 0) {
      console.log(`Incoming messages total: ${incoming.length}`);
      incoming = incoming.slice(0, overlapOffset);
      console.log(`Incoming messages new: ${incoming.length}`);
      if (group === "game_diplomacy") {
        // possibly the incoming messages replace old ones with updates
        const incomingKeys = incoming.map((m: any) => m.key);
        let indices: any[] = [];
        messageCache[group].forEach((message, i) => {
          if (incomingKeys.indexOf(message.key) !== -1) {
            indices.push(i);
          }
        });
        indices = indices.reverse();
        console.log(`Removing ${indices.length} old messages`);
        for (const i of indices) {
          messageCache[group].splice(i, 1);
        }
      }
    } else if (overlapOffset < 0) {
      const size = incoming.length * 2;
      if (size > 4096 || size <= 0) {
        logCount(`invalid_size_${size}`);
        return false;
      }
      console.log(`Missing some events for ${group}, double fetch to ${size}`);
      if (group === "game_event" || group === "game_diplomacy") {
        logCount("recursive_rrm");
        return requestRecentMessages(size, group);
      }
      logCount("call_rmc");
      return requestMessageComments(size, group);
    }
  }
  try {
    logCount("prestore");
    store(incoming, group);
    logCount("poststore");
    indexMessages(group, incoming);
    messageCache[group] = incoming.concat(messageCache[group]);
    logCount("postcache");
    console.log(
      `Return full message set for ${group} of ${messageCache[group].length}`,
    );
  } catch (err) {
    logCount(`ERROR ${err}`);
    console.error(err);
  }
  return true;
}

export function isNP4() {
  return true;
}

const getRequestPath = () => {
  if (isNP4()) {
    return "game_api";
  }
  if (NeptunesPride.gameVersion !== "proteus") {
    return "trequest_osric";
  }
  return "prequest";
};
export async function requestRecentMessages(
  fetchSize: number,
  group: "game_event" | "game_diplomacy" | string,
) {
  console.log("requestRecentMessages");
  const url = `/${getRequestPath()}/fetch_game_messages`;
  logCount(`requestRecentMessages ${fetchSize} ${group}`);
  const data = {
    type: "fetch_game_messages",
    count: messageCache[group].length > 0 ? fetchSize : 100000,
    offset: 0,
    group,
    version: NeptunesPride.version,
    game_number: getGameNumber(),
    gameId: getGameNumber(),
  };
  logCount(group);
  const response = await post(url, data);
  if (!response.report) {
    response.report = response[1];
  }
  return cacheEventResponseCallback(group, response);
}

export async function requestMessageComments(
  fetchSize: number,
  message_key: string,
) {
  console.log(`reqeustMessageComments ${fetchSize} for ${message_key}`);
  const url = `/${getRequestPath()}/fetch_game_message_comments`;
  const data = {
    type: "fetch_game_message_comments",
    count: fetchSize,
    offset: 0,
    message_key,
    version: NeptunesPride.version,
    game_number: getGameNumber(),
    gameId: getGameNumber(),
  };
  const response = await post(url, data);
  if (!response.report) {
    response.report = response[1];
  }
  return cacheEventResponseCallback(message_key, response);
}

const lastMessageCacheUpdate: { [k: string]: number } = {
  game_event: 0,
  game_diplomacy: 0,
};
export async function updateMessageCache(
  group: "game_event" | "game_diplomacy",
): Promise<boolean> {
  const timestamp = new Date().getTime();
  if (timestamp - lastMessageCacheUpdate[group] < 10 * 1000) {
    return true;
  }
  lastMessageCacheUpdate[group] = timestamp;
  console.log("updateMessageCache");
  return requestRecentMessages(4, group);
}

export async function anyEventsNewerThan(timestamp: number): Promise<boolean> {
  await updateMessageCache("game_event");
  return messageCache.game_event.filter((x) => timestamp < -x.date).length > 0;
}
