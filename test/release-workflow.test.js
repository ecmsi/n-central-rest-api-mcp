import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('versioned release workflow', () => {
  it('runs only for version tags and verifies repository version metadata', () => {
    assert.match(workflow, /tags:\s*\['v\*\.\*\.\*'\]/);
    assert.match(workflow, /npm run version:check -- "\$TAG_VERSION"/);
    assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-ecmsi\\\.\[0-9\]\+\$/);
  });

  it('verifies the portable gate on Windows before publishing anything', () => {
    assert.match(workflow, /verify-windows:[\s\S]*runs-on: windows-latest[\s\S]*npm run release:check:windows/);
    assert.match(workflow, /needs: \[verify, verify-windows\]/);
    assert.match(ciWorkflow, /test-windows:[\s\S]*runs-on: windows-latest[\s\S]*npm run release:check:windows/);
    assert.doesNotMatch(pkg.scripts['release:check:windows'], /test:coverage/);
    for (const name of Object.keys(pkg.scripts)) {
      assert.doesNotMatch(pkg.scripts[name], /^[A-Z_]+=\S*\s/, `${name} uses a POSIX-only env prefix`);
    }
  });

  it('attaches the package tarball and its checksum to the release', () => {
    assert.match(workflow, /npm shrinkwrap\s+mkdir -p dist\s+npm pack --pack-destination dist/);
    assert.match(workflow, /sha256sum/);
    assert.match(workflow, /"\$TARBALL" "\$TARBALL\.sha256"/);
    assert.deepEqual(pkg.files, ['index.js', 'src/', 'test/contract/mcp/legacy-tool-mappings.json', '.env.example']);
  });

  it('publishes a multi-platform GHCR image with semantic aliases', () => {
    assert.match(workflow, /packages: write/);
    assert.match(workflow, /registry:\s*ghcr\.io/);
    assert.match(workflow, /docker\/build-push-action@v6/);
    assert.match(workflow, /platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(workflow, /push:\s*true/);
    for (const pattern of ['{{version}}', '{{major}}.{{minor}}', '{{major}}']) {
      assert.ok(workflow.includes(`pattern=${pattern}`), pattern);
    }
    assert.match(workflow, /value=latest/);
  });

  it('uses the same aggregate gate for pull requests and tag verification', () => {
    assert.match(ciWorkflow, /pull_request:[\s\S]*npm run release:check/);
    assert.match(workflow, /name: Run release gates\s+run: npm run release:check/);
    assert.match(workflow, /needs: \[verify, verify-windows\][\s\S]*platforms:\s*linux\/amd64,linux\/arm64/);
    assert.match(pkg.scripts['release:check'], /npm run release:readiness:check/);
  });

  it('creates a GitHub Release only after the image is published', () => {
    assert.match(workflow, /contents: write/);
    assert.match(workflow, /needs:\s*publish-image/);
    assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
    assert.match(workflow, /--verify-tag/);
    assert.match(workflow, /--generate-notes/);
    assert.match(workflow, /\^sha256:\[a-f0-9\]\{64\}\$/);
    assert.match(workflow, /already exists; leaving it unchanged/);
    assert.doesNotMatch(workflow, /git tag\s+-f|git push\s+--force/);
  });

  it('provides explicit repository context to gh without requiring a checkout', () => {
    assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
  });
});
