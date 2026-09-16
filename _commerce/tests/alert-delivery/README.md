# Alert delivery end-to-end

A local harness that runs the real production monitor against a real HTTPS receiver
which answers exactly like Feishu, Slack and Telegram do.

```sh
npm run test:alert-delivery
```

What it proves:

- the payload sent to each channel matches that channel's schema
  (`{"msg_type":"text","content":{...}}` for Feishu, `{"text":...}` for Slack,
  `{"chat_id":...,"text":...}` for Telegram, raw `pawshop-monitor-alert-v1` for `generic`);
- a channel that answers **HTTP 200 with an application error** (Feishu `code != 0`,
  Telegram `ok:false`) is reported as a failed delivery — exit code 2, "alerting is
  broken" — instead of a delivered alert;
- an alert held back by the repeat-suppression window is exit 1, not exit 2;
- a `telegram` provider without a chat id refuses to run.

What it does not prove: that a real channel exists and accepts the message. That
needs the owner's webhook and is recorded per §9 of `docs/RUNBOOK.md`.

How it works: `run.sh` generates a throwaway certificate, starts `sink.mjs` on
`127.0.0.1:9443`, and runs the monitor with `dns-stub.mjs` imported so only the
vendor hostnames resolve to the sink. The webhook URLs keep their real hostnames,
so the monitor's provider host pinning is still enforced. The monitor is pointed at
the public storefront for its read-only probes, so network access is required.

Nothing here touches production, and no credentials are involved.
