import { redirect } from "next/navigation";
import { currentUser } from "@/lib/web/session";

export default async function Home() {
  redirect((await currentUser()) ? "/orgs" : "/sign-in");
}
