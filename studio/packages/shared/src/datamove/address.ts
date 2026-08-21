import { z } from 'zod';
import { ConnectionKindSchema } from '../schemas/connection.js';

/**
 * #996 M6 slice B (#1149, data-movement spec §2.1) — the RESOLVED ADDRESS a
 * dispatch actually reached.
 *
 * §2.1 states the debt this pays in as many words: a node holds a dataset
 * *ref*, not a literal address, so "a rerun writes wherever the dataset points
 * today, even though it pins the same `pipelineVersionId`". The compensating
 * control it names is this record — "the resolved address is recorded on
 * dispatch, so the run log says where it actually wrote, not merely which
 * dataset it named".
 *
 * It is a FROZEN FACT, minted once by the store's own adapter at dispatch and
 * never recomputed: the dataset row it came from is mutable, so a value derived
 * later would answer a different question. The reducer never reads it (an audit
 * fact, exactly like `node.failed.connectionId`), which is what keeps replay
 * deterministic while the field is additive.
 *
 * NON-SECRET COMPONENTS ONLY. §8 keeps credentials out of every event and a
 * paired activity resolves two of them, so a store's address may carry what
 * NAMES the data (a confined file path, a table) and never what unlocks it. A
 * future networked store (M10's postgres) records host/database/table and not
 * its password.
 */
export const DatasetAddressSchema = z.object({
  /** The store's connection kind — the vocabulary the two fields below are in. */
  kind: ConnectionKindSchema,
  /**
   * The store itself, as an operator would recognise it: for `sqlite` the
   * CONFINED database path. This is the half that answers "where did this data
   * go"; {@link DatasetAddressSchema.shape.storeIdentity} is the half that
   * answers "is that the same store as the other end".
   */
  store: z.string().min(1),
  /**
   * The PHYSICAL identity the STORE reports for itself, when it can be obtained
   * — `dev:ino` for a file-backed store, and (since #1193)
   * `<system_identifier>:<database oid>:<primary|standby>` for postgres.
   *
   * It exists because the path is NOT an identity, which was measured rather
   * than assumed. `resolveWithinRoots` canonicalises the target's PARENT and
   * joins the final component AS SPELLED (`server/src/connectors/confine.ts`),
   * so on a case-insensitive filesystem (APFS, the operator's Mac) `data.db`
   * and `Data.db` produce two confined paths for ONE inode. Compared on the
   * path alone, the self-copy gate below would wave through exactly the pair it
   * exists to refuse, and the sink would DELETE the rows the source is
   * streaming.
   *
   * `null` when the store could not be identified. That is the FAIL-OPEN
   * direction for the comparison and deliberately so: an unidentifiable store
   * falls back to `store` equality rather than minting a refusal on a fact
   * nobody established.
   *
   * HOW MUCH THAT FALLBACK CAN HIDE DIFFERS BY STORE, and the file case's
   * reassurance does NOT generalise. For a file store it hides nothing: both
   * ends open with `fileMustExist: true`, so a copy that would have run has two
   * readable files and therefore two identities. For a NETWORKED store the
   * fallback is to `host:port/database`, a string one server answers to under
   * several spellings — which is precisely the hole #1193 closed by giving the
   * address seam a credential. A postgres end reaches `null` here only when the
   * cluster REFUSES to identify itself (`pg_control_system()`'s execute
   * privilege is revocable), and that stays fail-open on purpose: the
   * alternative is refusing every copy against such a server forever, though
   * the role can read and write perfectly well.
   */
  storeIdentity: z.string().min(1).nullable(),
  /**
   * The object WITHIN the store, normalised for comparison: for a `table`
   * dataset the schema-qualified name, `nocaseFold`ed, with an unqualified name
   * resolved to its store's default (`main` under SQLite, which attaches
   * nothing).
   *
   * `null` when the address names no single object — a `query` dataset is a
   * SELECT over an arbitrary set of tables, and reducing it to one name would
   * be a guess. A null object never matches, so a `query` end can never be
   * refused as a self-copy; the residual is stated in {@link sameDatasetAddress}
   * rather than papered over.
   */
  object: z.string().min(1).nullable(),
});
export type DatasetAddress = z.infer<typeof DatasetAddressSchema>;

/**
 * Do two resolved addresses name ONE physical object?
 *
 * The predicate behind spec §3.1's physical self-copy refusal, and the reason
 * that refusal could not exist before M6: `DATASET_SELF_COPY` caught the
 * id-identical case only, so two DIFFERENT dataset rows naming one table went
 * through — and §4's atomic-swap sink DELETEs inside the write transaction
 * while the reader is still streaming, destroying precisely the rows it was
 * asked to move.
 *
 * Three rules, each in the safe direction:
 *
 * 1. **Different kinds are different addresses.** A `sqlite` path and some
 *    future store's opaque locator may coincide as strings; they name nothing
 *    in common.
 * 2. **Identity beats path when BOTH ends have one.** Two identities that
 *    differ prove two different stores, so the path is not consulted — a
 *    fallback there would re-admit the case-alias defect from the other side.
 *    When either is `null` the comparison degrades to the path, which is the
 *    only fact available.
 * 3. **A `null` object never matches, not even another `null`.** Two `query`
 *    datasets over one store are not known to overlap, and "unknown" must not
 *    be spelled "equal" — a `permanent` refusal of work that would have
 *    succeeded is the one direction §7's as-built block says a gate must never
 *    fail in.
 *
 * THE RESIDUAL, stated so it is not mistaken for coverage: a `query` source
 * reading the very table its sink overwrites, in the same store, is NOT caught.
 * Deciding it means reading the SQL to learn which tables it touches, and the
 * gate refuses to guess.
 *
 * M10 arrived and did NOT close it, which is a settled answer rather than an
 * outstanding one. #1196 measured the case against `postgres:17`: it is not a
 * data-loss path (the reader holds a `BEGIN READ ONLY` cursor snapshot and the
 * sink's `DELETE`+insert is one transaction), so it is a wasteful no-op. And
 * §7 ② is explicit that a `permanent` refusal reached by parsing an operator's
 * SQL badly is the one direction this gate must never fail in. #1193 gave
 * postgres a real `storeIdentity`, so the STORE half of such a pair now compares
 * correctly; the object half stays `null` deliberately.
 */
export function sameDatasetAddress(a: DatasetAddress, b: DatasetAddress): boolean {
  if (a.kind !== b.kind) return false;
  const sameStore =
    a.storeIdentity !== null && b.storeIdentity !== null
      ? a.storeIdentity === b.storeIdentity
      : a.store === b.store;
  if (!sameStore) return false;
  return a.object !== null && a.object === b.object;
}

/**
 * How an address reads in a refusal or a run log — "`/data/app.db` → `main.users`".
 *
 * TWO ways an address names no object BEYOND its store, and both read as one
 * value rather than as a truncation or a repetition:
 *  - `object` is `null` — a `query` dataset is a SELECT over an arbitrary set of
 *    tables, and reducing that to one name would be a guess;
 *  - `object` EQUALS `store` — `resolveDelimitedDatasetAddress` sets both to the
 *    same confined path deliberately, having rejected directory-as-store (it
 *    reopens the case-alias hole `storeIdentity` exists to close) and a constant
 *    `object` (a fact nobody established). Rendered naively that is
 *    "'/d/people.csv' → '/d/people.csv'", which reads as a rendering fault.
 *
 * DISPLAY ONLY. `sameDatasetAddress` still reads both halves, so collapsing them
 * here cannot make two addresses compare equal that did not before.
 */
export function describeDatasetAddress(address: DatasetAddress): string {
  return address.object === null || address.object === address.store
    ? `'${address.store}'`
    : `'${address.store}' → '${address.object}'`;
}
