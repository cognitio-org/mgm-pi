// GA-4 (#494): the read/write classifier for gcloud MCP commands. Anything not clearly a read asks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, tokenize } from "../.pi/extensions/gcloud-approval/classify.ts";

const g = (c: unknown) => classifyCommand("run_gcloud_command", c);
const bq = (c: unknown) => classifyCommand("run_bq_command", c);

describe("gcloud reads", () => {
  for (const c of [
    "gcloud compute instances list",
    "gcloud compute instances list --project=outfitter-509211 --format=json",
    "gcloud compute instances describe vm-1 --zone=us-central1-a",
    "compute instances list",
    "gcloud projects list",
    "gcloud projects describe outfitter-509211",
    "gcloud projects get-iam-policy outfitter-509211",
    "gcloud run services list --region=us-central1",
    "gcloud run services describe api --region us-central1",
    "gcloud logging read 'severity>=ERROR' --limit=10",
    'gcloud logging read "resource.type=cloud_run_revision AND severity>=ERROR" --limit 5 --format=json',
    "gcloud iam service-accounts list",
    "gcloud iam roles list",
    "gcloud container clusters list",
    "gcloud storage ls gs://bucket",
    "gcloud storage buckets list",
    "gcloud config list",
    "gcloud config get-value project",
    "gcloud services list --enabled",
    "gcloud kms keys list --keyring=k --location=global",
    "gcloud compute instances list-usable --format=json",
    "gcloud info",
    "gcloud version",
    "gcloud compute instances list --filter='name~^web'",
  ]) {
    test(`read: ${c}`, () => assert.equal(g(c), "read"));
  }
});

describe("gcloud writes and unknowns ask", () => {
  for (const c of [
    "gcloud compute instances delete vm-1",
    "gcloud compute instances create vm-1",
    "gcloud compute instances stop vm-1",
    "gcloud compute instances reset vm-1",
    "gcloud projects add-iam-policy-binding p --member=user:a@b.c --role=roles/owner",
    "gcloud projects set-iam-policy p policy.json",
    "gcloud run deploy api --image=x",
    "gcloud run services update api --memory=1Gi",
    "gcloud logging write my-log 'hello'",
    "gcloud secrets versions access latest --secret=s",
    "gcloud container clusters get-credentials c",
    "gcloud config set project x",
    "gcloud auth login",
    "gcloud storage rm gs://bucket/x",
    "gcloud storage cp a gs://b/",
    "gcloud services enable compute.googleapis.com",
    "gcloud",
    "",
    "   ",
    "list",
    "gcloud list",
    "gcloud frobnicate widgets list",
    "gcloud beta compute instances list",
    "gcloud alpha compute instances list",
  ]) {
    test(`write: ${JSON.stringify(c)}`, () => assert.equal(g(c), "write"));
  }

  test("a read verb word used as a resource name is not a read", () => {
    assert.equal(g("gcloud compute instances reset list"), "write");
    assert.equal(g("gcloud compute instances delete describe"), "write");
    assert.equal(g("gcloud compute instances stop list-things"), "write");
    assert.equal(g("gcloud compute instances frobnicate list"), "write");
    assert.equal(g("gcloud run services update list"), "write");
  });

  test("logging `read` only after logging", () => {
    assert.equal(g("gcloud compute read x"), "write");
  });

  test("not a string, or the wrong tool", () => {
    assert.equal(g(undefined), "write");
    assert.equal(g(42), "write");
    assert.equal(g({ command: "gcloud projects list" }), "write");
    assert.equal(classifyCommand("something_else", "gcloud projects list"), "write");
    assert.equal(classifyCommand("run_gcloud_command", "bq ls"), "write");
    assert.equal(bq("gcloud projects list"), "write");
  });

  test("an overlong command asks", () => {
    assert.equal(g(`gcloud projects list --filter=${"a".repeat(3000)}`), "write");
  });
});

describe("tricks", () => {
  for (const c of [
    "gcloud projects list; gcloud projects delete p",
    "gcloud projects list && rm -rf /",
    "gcloud projects list || true",
    "gcloud projects list | sh",
    "gcloud projects list & echo hi",
    "gcloud projects list > /tmp/x",
    "gcloud projects list < /etc/passwd",
    "gcloud projects list $(whoami)",
    "gcloud projects list `whoami`",
    "gcloud projects list --filter=$HOME",
    'gcloud projects list --filter="$HOME"',
    "gcloud projects list\ngcloud projects delete p",
    "gcloud projects list\rgcloud projects delete p",
    "gcloud projects list \\\n --quiet",
    "gcloud projects list --filter='unterminated",
    "gcloud projects list *",
    "gcloud projects list ~",
    "gcloud projects list (a)",
    "gcloud projects list {a,b}",
    "gcloud projects list #comment",
    "gcloud projects list\0",
  ]) {
    test(`write: ${JSON.stringify(c)}`, () => assert.equal(g(c), "write"));
  }

  for (const c of [
    "gcloud compute instances list --impersonate-service-account=sa@p.iam.gserviceaccount.com",
    "gcloud compute instances list --impersonate-service-account sa@p.iam.gserviceaccount.com",
    "gcloud compute instances list --impersonate",
    "gcloud compute instances list --account=other@x.com",
    "gcloud compute instances list --configuration=work",
    "gcloud compute instances list --access-token-file=/tmp/t",
    "gcloud compute instances list --flags-file=/tmp/f.yaml",
    "gcloud compute instances list --billing-project=other",
    'gcloud compute instances list "--impersonate-service-account=sa"',
    "gcloud --impersonate-service-account=sa compute instances list",
    "gcloud --project=p compute instances list",
  ]) {
    test(`write (identity or flag trick): ${c}`, () => assert.equal(g(c), "write"));
  }

  test("harmless flags are fine", () => {
    assert.equal(g("gcloud compute instances list --format=json --limit=5 --sort-by=name --quiet"), "read");
    assert.equal(g("gcloud compute instances list --verbosity=debug --project=p"), "read");
  });

  test("shell characters inside quotes are data, not syntax, except expansion", () => {
    assert.equal(g("gcloud logging read 'a;b|c&d' --limit=1"), "read");
    assert.equal(g("gcloud logging read 'a$b' --limit=1"), "write");
  });
});

describe("hidden separators and quoted flags", () => {
  for (const [name, c] of [
    ["tab", "gcloud projects list\t--impersonate-service-account=sa"],
    ["tab alone", "gcloud\tprojects\tlist"],
    ["NBSP", "gcloud projects list\u00a0--impersonate-service-account=sa"],
    ["U+2028", "gcloud projects list\u2028--account=x"],
    ["ideographic space", "gcloud\u3000projects list"],
    ["vertical tab", "gcloud projects list\u000b--account=x"],
    ["DEL", "gcloud projects list\u007f"],
    ["zero-width space", "gcloud projects\u200b list"],
    ["non-ASCII letter", "gcloud projects list --filter=caf\u00e9"],
    ["quoted flags inside one word", 'gcloud projects list "a --impersonate-service-account=x b"'],
    ["single-quoted flags inside one word", "gcloud projects list 'a --account=x'"],
    ["flag glued after quote", 'gcloud projects list --filter="x" --acc=y'],
  ] as const) {
    test(`write: ${name}`, () => assert.equal(g(c), "write"));
  }
});

describe("verb-like words are not groups", () => {
  for (const c of [
    "gcloud app deploy versions list",
    "gcloud app deploy list",
    "gcloud run deploy services list",
    "gcloud sql flags list",
    "gcloud artifacts docker tags list",
    "gcloud source repos list",
    "gcloud compute tags list",
    "gcloud run run list",
  ]) {
    test(`write: ${c}`, () => assert.equal(g(c), "write"));
  }
  test("the same nouns after their own group still read", () => {
    assert.equal(g("gcloud app versions list"), "read");
    assert.equal(g("gcloud deploy releases list"), "read");
  });
});

describe("tokenize", () => {
  test("splits on spaces, groups quotes, rejects syntax", () => {
    assert.deepEqual(tokenize("a  'b c' \"d e\" f=g"), ["a", "b c", "d e", "f=g"]);
    assert.deepEqual(tokenize("a '' b"), ["a", "", "b"]);
    assert.equal(tokenize("a; b"), undefined);
    assert.equal(tokenize("a $b"), undefined);
    assert.equal(tokenize("a 'b"), undefined);
  });
});

describe("bq", () => {
  for (const c of [
    "bq ls",
    "bq ls --format=json",
    "bq ls --project_id=p dataset",
    "bq ls --max_results=10 proj:dataset",
    "bq ls --all",
    "bq show proj:dataset.table",
    "bq show --format=prettyjson proj:dataset.table",
    "bq head -n 5 proj:ds.t".replace("-n 5", "--max_rows=5"),
    "ls",
    "bq --project_id=p ls",
    "bq --format=json show p:d.t",
    "bq query --maximum_bytes_billed=1000000000 --use_legacy_sql=false 'SELECT 1'",
    "bq query --maximum_bytes_billed=10000000000 --nouse_legacy_sql \"SELECT name FROM p.d.t LIMIT 5\"",
    "bq query --maximum_bytes_billed=1000 --nouse_legacy_sql --dry_run 'select * from d.t'",
    "bq query --maximum_bytes_billed=1000 'WITH x AS (SELECT 1 a) SELECT a FROM x'",
    "bq query --maximum_bytes_billed=1000 'SELECT COUNT(1) FROM d.t'",
  ]) {
    test(`read: ${c}`, () => assert.equal(bq(c), "read"));
  }

  for (const c of [
    "bq mk dataset",
    "bq rm -f d.t",
    "bq load d.t gs://b/f.csv",
    "bq cp a b",
    "bq insert d.t file.json",
    "bq update d.t",
    "bq extract d.t gs://b/f",
    "bq query 'INSERT INTO d.t VALUES (1)'",
    "bq query 'UPDATE d.t SET a=1 WHERE true'",
    "bq query 'DELETE FROM d.t WHERE true'",
    "bq query 'CREATE TABLE d.t AS SELECT 1'",
    "bq query 'DROP TABLE d.t'",
    "bq query 'MERGE d.t USING d.s ON true WHEN MATCHED THEN DELETE'",
    "bq query --maximum_bytes_billed=1000 'SELECT 1; DROP TABLE d.t'",
    "bq query --service_account=x --maximum_bytes_billed=1000 'SELECT 1'",
    "bq ls --credential_file=/tmp/c",
    "bq ls --bigqueryrc=/tmp/rc",
    "bq query --maximum_bytes_billed=1000 'SELECT \"a --impersonate_service_account=x b\"'",
    "bq query 'EXPORT DATA OPTIONS(uri=\"gs://b/*\") AS SELECT 1'",
    "bq query 'SELECT 1' 'SELECT 2'",
    "bq query 'SELECT 1'",
    "bq query --maximum_bytes_billed=10000000001 'SELECT 1'",
    "bq query --maximum_bytes_billed=0 'SELECT 1'",
    "bq query --maximum_bytes_billed=abc 'SELECT 1'",
    "bq query --maximum_bytes_billed 1000 'SELECT 1'",
    "bq query --maximum_bytes_billed=1000 \"SELECT * FROM EXTERNAL_QUERY('c', 'select 1')\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT * FROM ML.PREDICT(MODEL d.m, TABLE d.t)\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT AI.GENERATE('x')\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT * FROM VECTOR_SEARCH(TABLE d.t, 'e', TABLE d.q)\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT d.my_udf(x) FROM d.t\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT p.d.fn (x) FROM d.t\"",
    "bq query --maximum_bytes_billed=1000 \"SELECT NEXTVAL('s')\"",
    "bq query --maximum_bytes_billed=1000 --destination_table=d.t 'SELECT 1'",
    "bq query --destination_table=d.t 'SELECT 1'",
    "bq query --replace 'SELECT 1'",
    "bq query --append_table 'SELECT 1'",
    "bq query --parameter=a:INT64:1 'SELECT @a'",
    "bq query",
    "bq query 'CALL d.proc()'",
    "bq query 'BEGIN SELECT 1; END'",
    "bq query 'SELECT 1 INTO x'",
    "bq ls; bq rm d.t",
    "bq ls | sh",
    "bq show $(whoami)",
    "bq --service_account=x ls",
    "bq --project_id p ls",
    "bq ls --impersonate_service_account=sa",
    "bq ls -n 5",
    "bq",
    "bq frob",
  ]) {
    test(`write: ${c}`, () => assert.equal(bq(c), "write"));
  }
});
