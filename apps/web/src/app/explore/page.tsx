import { redirect } from "next/navigation";

// /explore used to render six hardcoded demo agents with invented ratings and
// token prices. The marketplace is the real, data-backed browse surface — send
// visitors there instead of maintaining a second (fake) one.
export default function ExplorePage() {
  redirect("/marketplace");
}
