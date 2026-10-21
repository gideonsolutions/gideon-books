/**
 * Create a demonstration company (synthetic data, clearly labeled) for a
 * user, creating the user if needed:
 *   npm run db:seed-demo -- --email you@example.com [--password '…'] [--name 'You']
 */
import { closeDb, getDb } from "../lib/db/client";
import { createUser, findUserByEmail } from "../lib/auth/users";
import { createDemoOrganization } from "../lib/demo/demo";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email");
  if (!email) throw new Error("--email is required");
  let user = await findUserByEmail(getDb(), email);
  if (!user) {
    const password = arg("password");
    if (!password) throw new Error(`${email} has no account; pass --password to create one`);
    user = await createUser({ email, name: arg("name") ?? email.split("@")[0]!, password }, { viaInvitation: true });
  }
  const org = await createDemoOrganization(user.id);
  console.log(JSON.stringify({ slug: org.slug, orgId: org.id, user: user.email }));
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error((e as Error).message);
    await closeDb().catch(() => {});
    process.exit(1);
  });
