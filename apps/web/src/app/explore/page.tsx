import { redirect } from "next/navigation";

// /explore is an old address for browsing agents; the marketplace is the one
// browse page, so visitors are sent there.
export default function ExplorePage() {
  redirect("/marketplace");
}
