# Calculate Versions Action

Calculate semantic versions for projects in a monorepo using git history and conventional commits.

## Description

This action analyzes your git history, identifies changes to projects and their dependencies, and calculates appropriate semantic version bumps based on conventional commit patterns.

## Usage

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # required: full history and tags
- uses: mr-version/setup@v1
- uses: mr-version/calculate@v1
  with:
    projects: '**/*.csproj'
    prerelease-type: 'beta'
```

The repository must be a full clone. A shallow clone (the `actions/checkout` default, `fetch-depth: 1`) has
neither the history nor the tags needed, which would silently version every project as `0.1.0`, so the step
fails with an error pointing to `fetch-depth: 0` (set `allow-shallow: true` to calculate anyway).

### How versions are calculated

When neither `prerelease-type`, `force-version`, `config-file` nor an auto-detected `mr-version.yml`
(`mr-version.yaml`, `mister-version.yml`, `mister-version.yaml`) in the repository root is in use, all
projects are calculated with a single `mr-version report --output json` call. Otherwise (and as a fallback
if `report` fails) the action runs `mr-version version --json` per project, up to four in parallel, because
`report` does not support those options and only applies part of `mr-version.yml`. Both paths produce the
same `projects` output; the job summary says which one was used.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `projects` | Glob patterns or project file paths to version, separated by commas and/or newlines (e.g. `src/**/*.csproj` or `src/A/A.csproj, src/B/B.csproj`). Relative patterns are resolved against `repository-path`; prefix a pattern with `!` to exclude matches. Project files outside `repository-path` are ignored. Brace expansion (`{a,b}`) is not supported. **The step fails when nothing matches.** | No | `**/*.csproj` |
| `repository-path` | Path to the Git repository root | No | `.` |
| `prerelease-type` | Prerelease type for main/dev branches (none, alpha, beta, rc) | No | `none` |
| `tag-prefix` | Prefix for version tags | No | `v` |
| `force-version` | Force a specific version for all projects | No | - |
| `config-file` | Path to `mr-version.yml` (auto-detected in the repository root if not specified) | No | - |
| `include-test-projects` | Include test projects in the results | No | `false` |
| `allow-shallow` | Calculate even if the repository is a shallow clone (otherwise the step fails) | No | `false` |
| `output-format` | Format of the detailed job summary output (json, yaml, text) | No | `json` |
| `output-version-information` | Add the detailed output to the job summary | No | `false` |
| `fail-on-no-changes` | Fail the action if no projects have version changes | No | `false` |
| `update-project-properties` | Update version properties in project files | No | `false` |
| `write-mrversion-props` | Write MrVersion.props file in each project directory | No | `false` |
| `dry-run` | Calculate versions but do not modify any files (skips `update-project-properties` and `write-mrversion-props`) | No | `false` |
| `dependencies` | **Deprecated, ignored.** Project dependencies (`ProjectReference`, direct and transitive) are detected automatically; for other paths use `projects.<name>.additionalMonitorPaths` in `mr-version.yml` | No | - |

## Outputs

| Output | Description |
|--------|-------------|
| `projects` | JSON array of project version information (see [Output Schema](#output-schema)) |
| `changed-projects` | JSON array of projects with version changes |
| `has-changes` | Whether any projects have version changes |
| `projects-count` | Number of projects in `projects` |
| `changed-count` | Number of projects in `changed-projects` |
| `summary` | Human-readable summary of version calculations |
| `version-map` | JSON map of project names/paths to their calculated versions |
| `version` | The version of the first changed project, or of the first project when none changed |
| `version-project` | Name of the project that `version`, `major`, `minor`, `patch` and `prerelease` come from |
| `major` | Major version number of `version` |
| `minor` | Minor version number of `version` |
| `patch` | Patch version number of `version` |
| `prerelease` | Prerelease label of `version`, verbatim (e.g. `rc.1`, `new-widget.2`; empty for a release version) |
| `has-validation-errors` | Whether any projects have validation errors |
| `has-validation-warnings` | Whether any projects have validation warnings |
| `validation-errors-count` | Number of projects with validation errors |
| `validation-warnings-count` | Number of projects with validation warnings |

Projects are listed in path order. Pass `projects` to [`mr-version/tag`](https://github.com/mr-version/tag)
as `projects-json` to tag exactly these versions.

## Examples

### Basic Version Calculation

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0  # Important: Full history needed
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    id: versions
  
  - name: Show Results
    run: |
      echo "Changed projects: ${{ steps.versions.outputs.changed-projects }}"
      echo "Has changes: ${{ steps.versions.outputs.has-changes }}"
```

### Prerelease Versions

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    with:
      prerelease-type: ${{ github.ref == 'refs/heads/main' && 'rc' || 'beta' }}
```

### Specific Projects

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    with:
      # comma- and/or newline-separated; relative to repository-path
      projects: |
        src/ServiceA/ServiceA.csproj,
        src/ServiceB/ServiceB.csproj
        src/Workers/**/*.csproj
        !src/Workers/Legacy/**
```

### Monitoring Additional Paths

Project references are tracked automatically (a change in a referenced project bumps its dependents). To
also bump a project when other directories change, configure them in `mr-version.yml`:

```yaml
projects:
  ServiceA:
    additionalMonitorPaths:
      - src/SharedAssets
```

### Calculate and Tag

```yaml
permissions:
  contents: write  # to push tags

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: mr-version/setup@v1

  - uses: mr-version/calculate@v1
    id: versions
    with:
      prerelease-type: rc

  - uses: mr-version/tag@v1
    if: steps.versions.outputs.has-changes == 'true'
    with:
      projects-json: ${{ steps.versions.outputs.projects }}
      push-tags: true
```

### Conditional Workflow

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    id: versions
  
  - name: Build Changed Projects
    if: steps.versions.outputs.has-changes == 'true'
    run: |
      echo '${{ steps.versions.outputs.changed-projects }}' | jq -r '.[].path' | while read project; do
        dotnet build "$project"
      done
```

### Output Processing

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    id: versions
    with:
      output-format: 'json'
  
  - name: Process Versions
    run: |
      echo '${{ steps.versions.outputs.projects }}' | jq '
        .[] | 
        "Project: \(.project)",
        "  Version: \(.version)",
        "  Changed: \(.versionChanged)",
        "  Reason: \(.changeReason)",
        ""
      '
```

### Using Version Map

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    id: versions
  
  - name: Use Version Map
    run: |
      # Get all versions as a map
      VERSION_MAP='${{ steps.versions.outputs.version-map }}'
      
      # Access specific project version
      SERVICE_A_VERSION=$(echo "$VERSION_MAP" | jq -r '."ServiceA"')
      echo "ServiceA version: $SERVICE_A_VERSION"
      
      # Access by path
      PATH_VERSION=$(echo "$VERSION_MAP" | jq -r '."src/ServiceA/ServiceA.csproj"')
      echo "Version by path: $PATH_VERSION"
```

### Update Project Files

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    with:
      update-project-properties: true
      write-mrversion-props: true
  
  - name: Commit Version Updates
    run: |
      git config user.name "github-actions"
      git config user.email "github-actions@github.com"
      git add -A
      git commit -m "chore: update version properties [skip ci]"
      git push
```

## Version Calculation Rules

### Conventional Commits
- `feat:` or `feature:` → Minor version bump
- `fix:` or `bugfix:` → Patch version bump
- `BREAKING CHANGE:` in footer → Major version bump
- `!` after type (e.g., `feat!:`) → Major version bump

### Change Detection
Projects are considered changed when:
1. Direct file changes in the project directory
2. Changes in configured dependencies
3. Changes in shared/common directories

### Version Precedence
1. Forced version (if specified)
2. Existing version tags in git
3. Version in project file
4. Default: 0.1.0 (also what every project gets from a shallow clone, which is why shallow clones fail the step)

## Configuration

### Global Configuration
Create `mr-version.yml` in repository root (picked up automatically, or pass `config-file`):

```yaml
tagPrefix: v
prereleaseType: beta
commitConventions:
  enabled: true
projects:
  MyService:
    additionalMonitorPaths:
      - src/SharedAssets
```

## Output Schema

### Projects Output
```json
[
  {
    "project": "MyService",
    "path": "/home/runner/work/repo/repo/src/MyService/MyService.csproj",
    "version": "1.3.0",
    "previousVersion": "1.2.4",
    "versionChanged": true,
    "changeReason": "Main branch: Incrementing minor version",
    "commitSha": "abc123d",
    "commitDate": "2024-03-01T10:00:00Z",
    "commitMessage": "feat: Add new feature",
    "branchType": "Main",
    "branchName": "main",
    "commitHeight": null,
    "isTestProject": false,
    "isPackable": true,
    "dependencies": ["/home/runner/work/repo/repo/src/SharedLibrary/SharedLibrary.csproj"],
    "validation": null
  }
]
```

`path` and `dependencies` are absolute project file paths (`dependencies` lists direct and transitive
project references). `previousVersion`, `branchName` and the commit fields are filled when the versions come
from the single `mr-version report` call and are `null` or missing on the per-project path.

### Version Map Output
```json
{
  "MyService": "1.3.0",
  "SharedLibrary": "2.1.0",
  "src/MyService/MyService.csproj": "1.3.0",
  "src/SharedLibrary/SharedLibrary.csproj": "2.1.0"
}
```

### MrVersion.props File
When `write-mrversion-props` is enabled, creates `MrVersion.props` in each project directory:

```xml
<Project>
  <!-- Generated by Mister.Version -->
  <PropertyGroup>
    <Version>1.3.0</Version>
    <VersionMajor>1</VersionMajor>
    <VersionMinor>3</VersionMinor>
    <VersionPatch>0</VersionPatch>
    <AssemblyVersion>1.3.0.0</AssemblyVersion>
    <FileVersion>1.3.0.0</FileVersion>
    <InformationalVersion>1.3.0+abc123d</InformationalVersion>
  </PropertyGroup>
</Project>
```

## Troubleshooting

### Shallow Clone Error
`The repository at '...' is a shallow clone ...`: use `actions/checkout` with `fetch-depth: 0` (or run
`git fetch --unshallow --tags` before this step). Only set `allow-shallow: true` if you know the needed
tags and history are present.

### No Project Files Matched
The `projects` patterns are relative to `repository-path` and separated by commas or newlines. Check the
pattern and the path shown in the error.

### No Changes Detected
- Ensure `fetch-depth: 0` in checkout action
- Check that conventional commit format is used
- Verify tag prefix matches existing tags

### Incorrect Versions
- Check for existing version tags
- Verify project file contains valid version
- Review commit messages for proper formatting

## License

This action is part of the Mister.Version project and is licensed under the MIT License.