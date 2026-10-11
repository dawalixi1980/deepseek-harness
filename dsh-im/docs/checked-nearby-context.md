# Checked Lark nearby context

For a registered same-Host exclusive consumer, `historyChecked` retains the existing account fingerprint, registration lifetime, live consumer and cancellation checks. This increment extends its `nearby` query; it does not add a standalone Session command or automatic subscription.

```js
await delivery.historyChecked(botId, authenticatedRoute, {
  scope: 'nearby', limit: 20,
  beforeCount: 10, afterCount: 5,
  // cursor: previous.nextCursor,
}, { expectedFingerprint, signal });
```

The checked original Human message anchors the inclusive +/-5-minute Chat window. Every visible supported Human text record in that window remains eligible, even when the window exceeds the count minima. The reader then supplements missing preceding/following records with the nearest older/newer supported messages. The anchor does not count toward either side. Each minimum defaults to 10/5 and accepts an integer 0–20; these options apply only to nearby queries.

Each call lists at most `limit` raw records (1–20). Empty pages can still carry `nextCursor`; continue until it is absent. Keep the same anchor, limit and minima. The composite cursor retains phase, side counts and the native page token. Unsupported records are omitted explicitly and do not satisfy minima. Exhausted history can return fewer records; future messages are never awaited. A fresh anchor's newer supplement ends without sending a future-start request, which Lark would reject when its default end time is now.

Results cover provider-visible supported Human text only. Lark Chat listing can omit topic replies, so use the separate `thread` scope for topic content; this reader does not synthesize a missing anchor or combine native Chat and Thread listings. Group/Thread query behavior remains unchanged. Application consumers continue to own durable storage, authorization, attention and any explicit reply.

Validated through BotHarness issue [#798](https://github.com/BotHarness/BotHarness/issues/798), including sparse/dense windows, timestamp boundaries, omissions, cursor binding, fresh-source exhaustion and real same-topic reply. This contribution is stacked on upstream PR #315, which is stacked on #313; neither is assumed merged.
