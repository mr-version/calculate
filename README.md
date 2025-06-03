# Calculate Versions Action

Calculate semantic versions for projects in a monorepo using git history and conventional commits.

## Description

This action analyzes your git history, identifies changes to projects and their dependencies, and calculates appropriate semantic version bumps based on conventional commit patterns.

## Usage

```yaml
- uses: mr-version/calculate@v1
  with:
    projects: '**/*.csproj'
    prerelease-type: 'beta'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `projects` | Glob pattern or list of project files to version (e.g., "src/**/*.csproj" or comma-separated paths) | No | `**/*.csproj` |
| `repository-path` | Path to the Git repository root | No | `.` |
| `prerelease-type` | Prerelease type for main/dev branches (none, alpha, beta, rc) | No | `none` |
| `tag-prefix` | Prefix for version tags | No | `v` |
| `force-version` | Force a specific version for all projects | No | - |
| `dependencies` | Comma-separated list of dependency paths to track for changes | No | - |
| `output-format` | Output format (json, yaml, text) | No | `json` |
| `fail-on-no-changes` | Fail the action if no projects have version changes | No | `false` |
| `update-project-properties` | Update version properties in project files | No | `false` |
| `write-mrversion-props` | Write MrVersion.props file in each project directory | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `projects` | JSON array of project version information |
| `changed-projects` | JSON array of projects with version changes |
| `has-changes` | Whether any projects have version changes |
| `summary` | Human-readable summary of version calculations |
| `version-map` | JSON map of project names/paths to their calculated versions |
| `version` | The calculated version of the first changed project (if any) |
| `major` | Major version number of the first changed project |
| `minor` | Minor version number of the first changed project |
| `patch` | Patch version number of the first changed project |
| `prerelease` | Prerelease version string of the first changed project (if any) |

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
      projects: |
        src/ServiceA/ServiceA.csproj,
        src/ServiceB/ServiceB.csproj
```

### With Dependencies

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  
  - uses: mr-version/setup@v1
  
  - uses: mr-version/calculate@v1
    with:
      dependencies: |
        src/SharedLibrary/**/*,
        src/Common/**/*
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
4. Default: 0.1.0

## Configuration

### Global Configuration
Create `mr-version.yml` in repository root:

```yaml
tagPrefix: v
prereleaseType: beta
dependencies:
  - src/SharedLibrary/**/*
  - src/Common/**/*
```

### Project Configuration
In your `.csproj` file:

```xml
<PropertyGroup>
  <Version>1.0.0</Version>
  <VersionDependencies>../SharedLibrary;../Common</VersionDependencies>
</PropertyGroup>
```

## Output Schema

### Projects Output
```json
[
  {
    "project": "MyService",
    "path": "src/MyService/MyService.csproj",
    "version": "1.3.0",
    "versionChanged": true,
    "changeReason": "Project changes detected",
    "commitSha": "abc123def",
    "commitDate": "2024-03-01T10:00:00Z",
    "commitMessage": "feat: Add new feature",
    "branchType": "main",
    "branchName": "main",
    "isTestProject": false,
    "isPackable": true,
    "dependencies": ["SharedLibrary", "Common"]
  }
]
```

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