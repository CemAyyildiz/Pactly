import { shortenStellarId, stellarExplorerContractUrl, stellarExplorerTransactionUrl } from "../lib/stellar";

export interface EscrowProofProps {
  contractId?: string;
  txHash?: string;
}

/** DESIGN.md's `Escrow proof`: a secondary mono label under the funded
 * state, "Escrow powered by Trustless Work on Stellar" plus a shortened
 * contract/transaction record linking to the testnet explorer. Always
 * secondary evidence, never a competing CTA -- rendered as plain text and
 * a link, never a button. */
export function EscrowProof({ contractId, txHash }: EscrowProofProps) {
  return (
    <p className="escrow-proof">
      <span>ESCROW POWERED BY TRUSTLESS WORK ON STELLAR</span>
      {contractId && (
        <a href={stellarExplorerContractUrl(contractId)} target="_blank" rel="noreferrer">
          {shortenStellarId(contractId)} &#8599;
        </a>
      )}
      {txHash && (
        <a href={stellarExplorerTransactionUrl(txHash)} target="_blank" rel="noreferrer">
          {shortenStellarId(txHash)} &#8599;
        </a>
      )}
    </p>
  );
}
