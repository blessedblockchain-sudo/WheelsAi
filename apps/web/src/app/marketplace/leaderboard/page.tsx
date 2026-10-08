import { Leaderboard } from "@/components/marketplace/leaderboard";
import { MarketplacePublicShell } from "@/components/marketplace/public-shell";

/** The public leaderboard. Signed-in publishers also see it as a Listings tab in the dashboard. */
export default function LeaderboardPage() {
  return (
    <MarketplacePublicShell current="leaderboard">
      <Leaderboard />
    </MarketplacePublicShell>
  );
}
