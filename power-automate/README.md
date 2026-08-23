# Test request approval flow (Power Automate)

Same pattern as the existing **Service Request** procedure flow, retargeted to a
SharePoint list named `Test`.

## Files

- `test-request-approval-flow.json` — the whole flow definition (trigger + all actions).
  Use this when you want to build the flow from scratch or import it.
- `test-request-apply-to-each.json` — just the `Apply to each` scope, matching what
  Code view shows when the `Apply to each` action is selected. Paste this into the
  Code view of an `Apply to each` action in a flow that already has a
  `Start and wait for an approval` action.

## Flow shape

1. **When a test item is created** — SharePoint list `Test`.
2. **Set test item to pending** — `Status = Pending`.
3. **Start and wait for an approval** — Approve/Reject, first to respond.
4. **Apply to each** over `body/responses`:
   - **Condition**: `approverResponse` equals `Approve`
     - **If yes**: email the item creator, set `Status = Approved`, store approver comments.
     - **If no**: email the item creator, set `Status = Rejected`, store approver comments.

## Before you save

Replace these placeholders:

| Placeholder | Replace with |
| --- | --- |
| `https://contoso.sharepoint.com/sites/YourSite` | your site URL |
| `Test` | your list name, if different |
| `approver@contoso.com` | the approver (or a dynamic field such as `@{triggerOutputs()?['body/Approver/Email']}`) |
| `operationMetadataId` | leave as-is; Power Automate regenerates it on save |

The list needs a choice column `Status` (Pending / Approved / Rejected), a
multi-line text column `ApproverComments`, and a `Description` column — or remove
those lines from the `PatchItem` actions if your list is simpler.

Connection names (`shared_sharepointonline`, `shared_approvals`, `shared_office365`)
are re-bound by the designer to your own connections when the flow is saved.
