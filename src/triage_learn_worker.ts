import { connect } from "./db.ts";
import { learn, type LearnResult } from "./triage_score.ts";

interface LearnRequest {
  path: string;
}

type LearnReply = { ok: true; result: LearnResult } | { ok: false; message: string };

declare const self: Worker;

self.onmessage = (event: MessageEvent<LearnRequest>) => {
  try {
    const connection = connect(event.data.path);

    try {
      const result = learn(connection, { apply: true });

      self.postMessage({ ok: true, result } satisfies LearnReply);
    } finally {
      connection.close();
    }
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies LearnReply);
  }
};
