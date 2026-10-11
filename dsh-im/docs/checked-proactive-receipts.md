# Checked proactive group receipts

`dshIm.receiptVersion === 1` advertises an optional `sendChecked(..., { receipt: true })` contract. Existing sends still return `{ sent: true }`.

The account must advertise `proactive-receipt-checked`. The saved target must be a group; account fingerprint, target digest, Registration and the existing `beforeSend` fence are checked before dispatch. Lark/Feishu SDK message creation returns a minimal `{ sent: true, receipt: { version: 1, messageId, conversationId } }`, validated against the frozen target. No full provider response or credentials are exposed.

A missing or mismatched receipt after dispatch raises `send-result-unknown`. It can mean the platform accepted the message: callers must retain an unknown outcome and must not automatically retry. The receipt proves platform acceptance, not delivery or Human read status. Consumers may retain these IDs in their own canonical Outbox to associate future topic replies with the original report.

This increment adds no inbound consumer, self-echo callback, scheduler, or retry mechanism.
