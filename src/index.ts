import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as glob from '@actions/glob'
import * as path from 'path'
import * as fs from 'fs/promises'

interface ProjectVersion {
  project: string  // Changed from 'name' to match CLI output
  path: string
  version: string
  versionChanged: boolean
  changeReason?: string
  commitSha?: string
  commitDate?: string
  commitMessage?: string
  branchType?: string
  branchName?: string
  isTestProject: boolean
  isPackable: boolean
  dependencies: string[]
}

interface VersionCalculationResult {
  projects: ProjectVersion[]
  changedProjects: ProjectVersion[]
  hasChanges: boolean
  summary: string
}

async function run(): Promise<void> {
  try {
    const projectsInput = core.getInput('projects') || '**/*.csproj'
    const repositoryPath = core.getInput('repository-path') || '.'
    const prereleaseType = core.getInput('prerelease-type') || 'none'
    const tagPrefix = core.getInput('tag-prefix') || 'v'
    const forceVersion = core.getInput('force-version')
    const dependencies = core.getInput('dependencies')
    const outputFormat = core.getInput('output-format') || 'json'
    const failOnNoChanges = core.getBooleanInput('fail-on-no-changes')
    const updateProjectProperties = core.getBooleanInput('update-project-properties')
    const writeMrVersionProps = core.getBooleanInput('write-mrversion-props')
    const configFile = core.getInput('config-file')
    const outputVersionInformation = core.getBooleanInput('output-version-information')
    const dryRun = core.getBooleanInput('dry-run')
    const includeTestProjects = core.getBooleanInput('include-test-projects')

    core.info('Calculating project versions...')

    // Find project files
    const projectFiles = await findProjectFiles(projectsInput, repositoryPath)
    core.info(`Found ${projectFiles.length} project files`)
    
    if (!includeTestProjects) {
      core.info('Test projects will be excluded from results')
    }

    if (projectFiles.length === 0) {
      if (failOnNoChanges) {
        core.setFailed('No project files found and fail-on-no-changes is enabled')
        return
      }
      core.warning('No project files found matching the pattern')
    }

    // Calculate versions for each project
    const results: ProjectVersion[] = []
    for (const projectFile of projectFiles) {
      const result = await calculateProjectVersion({
        projectFile,
        repositoryPath,
        prereleaseType,
        tagPrefix,
        forceVersion,
        dependencies,
        configFile,
        dryRun
      })
      results.push(result)
    }

    // Analyze results
    const analysisResult = analyzeResults(results, includeTestProjects)

    // Check for failures
    if (failOnNoChanges && !analysisResult.hasChanges) {
      core.setFailed('No version changes detected and fail-on-no-changes is enabled')
      return
    }

    // Create version map and set outputs
    const versionMap = createVersionMap(analysisResult.projects)
    core.setOutput('projects', JSON.stringify(analysisResult.projects))
    core.setOutput('changed-projects', JSON.stringify(analysisResult.changedProjects))
    core.setOutput('has-changes', analysisResult.hasChanges.toString())
    core.setOutput('summary', analysisResult.summary)
    core.setOutput('version-map', JSON.stringify(versionMap))

    // Set individual version components from the first project
    if (analysisResult.projects.length > 0) {
      const firstProject = analysisResult.projects[0]
      const versionParts = firstProject.version.split(/[.-]/)

      core.setOutput('version', firstProject.version)
      core.setOutput('major', versionParts[0] || '0')
      core.setOutput('minor', versionParts[1] || '0')
      core.setOutput('patch', versionParts[2] || '0')
      core.setOutput('prerelease', versionParts.length > 3 ? versionParts.slice(3).join('.') : '')
    } else {
      core.setOutput('version', '0.1.0')
      core.setOutput('major', '0')
      core.setOutput('minor', '1')
      core.setOutput('patch', '0')
      core.setOutput('prerelease', '')
    }

    // Update project properties if requested
    if (updateProjectProperties || writeMrVersionProps) {
      if (dryRun) {
        core.info('[DRY RUN] Would update project properties')
      } else {
        await updateProjects(analysisResult.projects, updateProjectProperties, writeMrVersionProps)
      }
    }

    if (outputVersionInformation) {
      // Add to job summary
      await core.summary
        .addHeading('📊 Version Calculation Results')
        .addCodeBlock(formatSummary(analysisResult, outputFormat), outputFormat)
        .write()
    }

    core.info(`✅ Analyzed ${results.length} projects, ${analysisResult.changedProjects.length} with changes`)

  } catch (error) {
    core.setFailed(`Failed to calculate versions: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function findProjectFiles(pattern: string, repositoryPath: string): Promise<string[]> {
  const globber = await glob.create(pattern, {
    matchDirectories: false,
    implicitDescendants: true
  })

  const files = await globber.glob()

  // Filter to only include actual project files
  return files.filter(file =>
    file.endsWith('.csproj') ||
    file.endsWith('.vbproj') ||
    file.endsWith('.fsproj')
  ).map(file => path.resolve(repositoryPath, file))
}

interface CalculateVersionOptions {
  projectFile: string
  repositoryPath: string
  prereleaseType: string
  tagPrefix: string
  forceVersion?: string
  dependencies?: string
  configFile?: string
  dryRun?: boolean
}

async function calculateProjectVersion(options: CalculateVersionOptions): Promise<ProjectVersion> {
  const args = [
    'version',
    '--repo', options.repositoryPath,
    '--project', options.projectFile,
    '--json'
  ]

  if (options.prereleaseType && options.prereleaseType !== 'none') {
    args.push('--prerelease-type', options.prereleaseType)
  }

  if (options.tagPrefix) {
    args.push('--tag-prefix', options.tagPrefix)
  }

  if (options.forceVersion) {
    args.push('--force-version', options.forceVersion)
  }

  if (options.dependencies) {
    args.push('--dependencies', options.dependencies)
  }

  if (options.configFile) {
    args.push('--config-file', options.configFile)
  }

  if (options.dryRun) {
    args.push('--dry-run')
  }

  const output = await exec.getExecOutput('mr-version', args, {
    silent: true,
    ignoreReturnCode: true
  })

  if (output.exitCode !== 0) {
    throw new Error(`mr-version failed for ${options.projectFile}: ${output.stderr}`)
  }

  try {
    const stdout = output.stdout.trim()
    if (!stdout) {
      throw new Error('mr-version returned empty output')
    }

    return JSON.parse(stdout) as ProjectVersion
  } catch (error) {
    throw new Error(`Failed to parse mr-version output for ${options.projectFile}: ${error}`)
  }
}

function analyzeResults(projects: ProjectVersion[], includeTestProjects: boolean): VersionCalculationResult {
  // Filter out test projects if not included
  const testProjectCount = projects.filter(p => p.isTestProject).length
  const filteredProjects = includeTestProjects 
    ? projects 
    : projects.filter(p => !p.isTestProject)
  
  if (!includeTestProjects && testProjectCount > 0) {
    core.info(`Filtered out ${testProjectCount} test project(s)`)
  }
  
  const changedProjects = filteredProjects.filter(p => p.versionChanged)
  const hasChanges = changedProjects.length > 0

  const summary = generateSummary(filteredProjects, changedProjects)

  return {
    projects: filteredProjects,
    changedProjects,
    hasChanges,
    summary
  }
}

function generateSummary(allProjects: ProjectVersion[], changedProjects: ProjectVersion[]): string {
  const lines: string[] = []

  lines.push(`**📊 Version Calculation Summary**`)
  lines.push(`- Total projects: ${allProjects.length}`)
  lines.push(`- Projects with changes: ${changedProjects.length}`)
  lines.push(`- Projects unchanged: ${allProjects.length - changedProjects.length}`)

  if (changedProjects.length > 0) {
    lines.push('')
    lines.push('**🔄 Changed Projects:**')
    for (const project of changedProjects) {
      lines.push(`- **${project.project}**: ${project.version} _(${project.changeReason})_`)
    }
  }

  if (allProjects.length - changedProjects.length > 0) {
    lines.push('')
    lines.push('**✅ Unchanged Projects:**')
    for (const project of allProjects.filter(p => !p.versionChanged)) {
      lines.push(`- **${project.project}**: ${project.version}`)
    }
  }

  return lines.join('\n')
}

function formatSummary(result: VersionCalculationResult, format: string): string {
  switch (format.toLowerCase()) {
    case 'yaml':
      return formatAsYaml(result)
    case 'text':
      return formatAsText(result)
    case 'json':
    default:
      return JSON.stringify(result, null, 2)
  }
}

function formatAsYaml(result: VersionCalculationResult): string {
  const lines: string[] = []
  lines.push('```yaml')
  lines.push('projects:')
  for (const project of result.projects) {
    lines.push(`  - name: ${project.project}`)
    lines.push(`    version: ${project.version}`)
    lines.push(`    changed: ${project.versionChanged}`)
    if (project.changeReason) {
      lines.push(`    reason: "${project.changeReason}"`)
    }
  }
  lines.push('```')
  return lines.join('\n')
}

function formatAsText(result: VersionCalculationResult): string {
  const lines: string[] = []
  lines.push('```')
  lines.push('Project Versions:')
  lines.push('================')
  for (const project of result.projects) {
    const status = project.versionChanged ? '🔄 CHANGED' : '✅ UNCHANGED'
    lines.push(`${status} ${project.project}: ${project.version}`)
    if (project.changeReason) {
      lines.push(`    Reason: ${project.changeReason}`)
    }
  }
  lines.push('```')
  return lines.join('\n')
}

function createVersionMap(projects: ProjectVersion[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const project of projects) {
    // Use project name as key
    map[project.project] = project.version
    // Also add path-based key for convenience
    const relativePath = path.relative(process.cwd(), project.path)
    map[relativePath] = project.version
  }
  return map
}

async function updateProjects(projects: ProjectVersion[], updateProperties: boolean, writeProps: boolean): Promise<void> {
  for (const project of projects) {
    try {
      if (updateProperties) {
        await updateProjectFile(project)
      }

      if (writeProps) {
        await writeMrVersionPropsFile(project)
      }
    } catch (error) {
      core.warning(`Failed to update project ${project.project}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function updateProjectFile(project: ProjectVersion): Promise<void> {
  const content = await fs.readFile(project.path, 'utf8')

  // Parse version components
  const versionMatch = project.version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!versionMatch) {
    core.warning(`Cannot parse version ${project.version} for ${project.project}`)
    return
  }

  const [, major, minor, patch, prerelease] = versionMatch

  // Update version properties in the project file
  let updatedContent = content

  // Update Version property if it exists
  updatedContent = updatedContent.replace(
    /<Version>.*<\/Version>/g,
    `<Version>${project.version}</Version>`
  )

  // Update individual version components if they exist
  updatedContent = updatedContent.replace(
    /<VersionMajor>.*<\/VersionMajor>/g,
    `<VersionMajor>${major}</VersionMajor>`
  )
  updatedContent = updatedContent.replace(
    /<VersionMinor>.*<\/VersionMinor>/g,
    `<VersionMinor>${minor}</VersionMinor>`
  )
  updatedContent = updatedContent.replace(
    /<VersionPatch>.*<\/VersionPatch>/g,
    `<VersionPatch>${patch}</VersionPatch>`
  )

  if (prerelease) {
    updatedContent = updatedContent.replace(
      /<VersionSuffix>.*<\/VersionSuffix>/g,
      `<VersionSuffix>${prerelease}</VersionSuffix>`
    )
  }

  // Only write if content changed
  if (updatedContent !== content) {
    await fs.writeFile(project.path, updatedContent, 'utf8')
    core.info(`Updated version properties in ${project.project}`)
  }
}

async function writeMrVersionPropsFile(project: ProjectVersion): Promise<void> {
  const projectDir = path.dirname(project.path)
  const propsPath = path.join(projectDir, 'MrVersion.props')

  // Parse version components
  const versionMatch = project.version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!versionMatch) {
    core.warning(`Cannot parse version ${project.version} for ${project.project}`)
    return
  }

  const [, major, minor, patch, prerelease] = versionMatch

  // Create MSBuild props file content
  const propsContent = `<Project>
  <!-- Generated by Mister.Version -->
  <PropertyGroup>
    <Version>${project.version}</Version>
    <VersionMajor>${major}</VersionMajor>
    <VersionMinor>${minor}</VersionMinor>
    <VersionPatch>${patch}</VersionPatch>${prerelease ? `
    <VersionSuffix>${prerelease}</VersionSuffix>` : ''}
    <AssemblyVersion>${major}.${minor}.${patch}.0</AssemblyVersion>
    <FileVersion>${major}.${minor}.${patch}.0</FileVersion>
    <InformationalVersion>${project.version}${project.commitSha ? `+${project.commitSha.substring(0, 7)}` : ''}</InformationalVersion>
  </PropertyGroup>
</Project>
`

  await fs.writeFile(propsPath, propsContent, 'utf8')
  core.info(`Created MrVersion.props for ${project.project}`)
}

// Run the action
if (require.main === module) {
  run()
}

export { run }