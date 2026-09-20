import { stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../lib/stellar";

export interface EscrowProofProps {
  contractId?: string;
  txHash?: string;
}

/** DESIGN.md's `Escrow proof`: a secondary mono label under the funded
 * state, "Deposit held in escrow by Trustless Work", plus plain-language
 * links to the escrow record and the payment record (they open the public
 * ledger explorer -- the destination may show technical detail, the link
 * text never does), and a second link into Trustless Work's own Escrow
 * Viewer (roles, milestones, balances read straight from its read model).
 * Always secondary evidence, never a competing CTA -- rendered as plain
 * text and links, never a button. */
export function EscrowProof({ contractId, txHash }: EscrowProofProps) {
  return (
    <p className="escrow-proof">
      <span>DEPOSIT HELD IN ESCROW BY TRUSTLESS WORK</span>
      {contractId && (
        <a href={stellarExplorerContractUrl(contractId)} target="_blank" rel="noreferrer">
          View escrow record &#8599;
        </a>
      )}
      {txHash && (
        <a href={stellarExplorerTransactionUrl(txHash)} target="_blank" rel="noreferrer">
          View payment record &#8599;
        </a>
      )}
      {contractId && (
        <a href={trustlessWorkViewerUrl(contractId)} target="_blank" rel="noreferrer">
          View in Escrow Viewer &#8599;
        </a>
      )}
    </p>
  );
}
