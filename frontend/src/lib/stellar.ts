/**
 * The escrow proof line's own small helpers (DESIGN.md's `Escrow proof`
 * component): a shortened contract/transaction id, and the testnet
 * explorer link it opens. Kept out of `money.ts`/`time.ts` since neither
 * is about formatting an amount or a time.
 */

/** `"CDLZ…7KQ4"` -- the first and last 4 characters, an ellipsis between.
 * Falls back to the full value when it is already short enough that
 * shortening it would not save anything. */
export function shortenStellarId(id: string): string {
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Stellar Expert's testnet explorer -- the "verifiable link" the spec's
 * escrow proof line and the locked-confirmation screen both need. Contract
 * ids (`C...`) and transaction hashes use different explorer paths. */
export function stellarExplorerContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`;
}

export function stellarExplorerTransactionUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
}

/** Trustless Work's own Escrow Viewer (`github.com/Trustless-Work/escrow-viewer`)
 * -- a dynamic `/[id]` route that looks up an escrow by contract id and
 * renders its roles, milestones and balances without the visitor needing to
 * read raw ledger data. A second, escrow-shaped proof alongside the plain
 * Stellar Expert contract link above: that one proves the contract exists on
 * chain, this one proves what Trustless Work's own read model says its
 * roles/milestones/state actually are. */
export function trustlessWorkViewerUrl(contractId: string): string {
  return `https://viewer.trustlesswork.com/${contractId}`;
}
