import { seg, type WheelsAIClient } from "../client.js";
import type { Destination } from "./agents.js";

export type DestinationType = "slack" | "discord" | "email";

/** What `destinations.create` sends. */
export interface CreateDestinationInput {
  type: DestinationType;
  /** The pasted Slack or Discord link. Not for `email`. */
  link?: string;
  /** Up to 80 characters. Left out, it is named after the service: "Slack", "Slack 2"; an email place is "Email to <display name>", or "Email to a teammate". */
  name?: string;
}

/** The places an agent's results can be sent to. No answer carries a link or an address. */
export function destinationsResource(client: WheelsAIClient) {
  return {
    /** `GET /api/destinations`: the places that are turned on, by id, name and type. */
    list: () => client.get<Destination[]>("/api/destinations"),

    /**
     * `POST /api/destinations`. Slack or Discord by the link the service gave you (400 `invalid_link`
     * when it is not that service's link). `email` takes no address: it is the signed-in person's
     * own verified address, so an API key cannot choose it (400 `email_needs_sign_in`), and an
     * address that is not verified answers 400 `email_not_verified`. A name already in use answers
     * 409 `name_taken`. Choosing email again returns the same place.
     */
    create: (input: CreateDestinationInput) => client.post<Destination>("/api/destinations", input),

    /** `POST /api/destinations/{channelId}/test`: sends a short test message. 502 `delivery_failed` when it did not arrive. */
    test: (channelId: string) => client.post<{ sent: true }>(`/api/destinations/${seg(channelId)}/test`),
  };
}
