"use client";

import { useId } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WALLET_PAYMENT_WORDS, walletPaymentLines } from "@/lib/sell-x402";

export interface WalletPaymentsProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The price of one use the lines name; null while the typed price cannot be sold. */
  priceCents: number | null;
  /** The API's refusal of the switch, in its own sentence, drawn under the switch; null when there is none. */
  error?: string | null;
  disabled?: boolean;
}

/**
 * The creator's switch for paying from a wallet: people with no account pay
 * one use of the agent from their own Solana wallet. Drawn by "Who can use
 * it?" under pay per use, only when paying from a wallet is available. Every
 * word is the pure file's.
 */
export function WalletPayments({ checked, onChange, priceCents, error = null, disabled = false }: WalletPaymentsProps) {
  const id = useId();
  const lines = walletPaymentLines(priceCents);
  const describedBy = error ? `${id}-wallet-error ${id}-wallet-lines` : `${id}-wallet-lines`;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={`${id}-wallet`} className="text-sm font-medium text-foreground">
          {WALLET_PAYMENT_WORDS.label}
        </Label>
        <Switch
          id={`${id}-wallet`}
          checked={checked}
          onCheckedChange={onChange}
          aria-describedby={describedBy}
          disabled={disabled}
        />
      </div>
      {error && (
        <p id={`${id}-wallet-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div id={`${id}-wallet-lines`} className="space-y-2">
        {lines.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
