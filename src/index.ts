import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs/promises'
import { evaluateHistory, inspectHistory } from './git'
import { CalculationResult, ProjectVersion, ValidationError, ValidationWarning, calculateVersions } from './mrversion'
import { findProjectFiles } from './projects'
import { parseVersion, selectPrimaryProject } from './version'

interface VersionCalculationResult {
  projects: ProjectVersion[]
  changedProjects: ProjectVersion[]
  hasChanges: boolean
  summary: string
}

const CALCULATION_MODES: Record<CalculationResult['mode'], string> = {
  'report': 'one `mr-version report` call',
  'per-project': 'one `mr-version version` call per project',
  'report+per-project': '`mr-version report` plus per-project `mr-version version` calls'
}

/** Like core.getBooleanInput, but an unset input means `defaultValue` instead of an error. */
function getBooleanInput(name: string, defaultValue = false): boolean {
  return core.getInput(name).trim() === '' ? defaultValue : core.getBooleanInput(name)
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
    const failOnNoChanges = getBooleanInput('fail-on-no-changes')
    const updateProjectProperties = getBooleanInput('update-project-properties')
    const writeMrVersionProps = getBooleanInput('write-mrversion-props')
    const configFile = core.getInput('config-file')
    const outputVersionInformation = getBooleanInput('output-version-information')
    const dryRun = getBooleanInput('dry-run')
    const includeTestProjects = getBooleanInput('include-test-projects')
    const allowShallow = getBooleanInput('allow-shallow')
    const repositoryRoot = path.resolve(repositoryPath)

    core.info('Calculating project versions...')

    if (dependencies) {
      core.warning(
        "The 'dependencies' input is ignored: mr-version tracks each project's ProjectReference dependencies " +
        '(direct and transitive) automatically. Use projects.<name>.additionalMonitorPaths in mr-version.yml for other paths.'
      )
    }

    // Refuse to calculate from a shallow clone: it silently yields 0.1.0 for every project
    const history = await inspectHistory(repositoryRoot, tagPrefix)
    const verdict = evaluateHistory(history, allowShallow)
    if (verdict.level === 'error') {
      throw new Error(verdict.message)
    } else if (verdict.level === 'warning') {
      core.warning(verdict.message ?? '')
    } else if (verdict.level === 'notice') {
      core.notice(verdict.message ?? '')
    }

    // Find project files (relative patterns are resolved against repository-path)
    const selection = await findProjectFiles(projectsInput, repositoryRoot)
    const projectFiles = selection.files
    if (selection.outside.length > 0) {
      core.info(`Ignored ${selection.outside.length} project file(s) outside ${repositoryRoot}: ${selection.outside.join(', ')}`)
    }
    core.info(`Found ${projectFiles.length} project files`)

    if (!includeTestProjects) {
      core.info('Test projects will be excluded from results')
    }

    // Calculate versions (one `mr-version report` call when possible, else one `mr-version version` per project)
    const calculation: CalculationResult = await calculateVersions({
      repositoryRoot,
      gitRoot: history.gitRoot,
      projectFiles,
      prereleaseType,
      tagPrefix,
      forceVersion,
      configFile
    })
    const results = calculation.projects
    core.info(`Calculated ${results.length} project versions (${calculation.mode}${calculation.reason ? `: ${calculation.reason}` : ''})`)

    // Analyze results
    const analysisResult = analyzeResults(results, includeTestProjects)

    if (analysisResult.projects.length === 0) {
      throw new Error(
        `All ${results.length} matched project(s) are test projects, which are excluded. ` +
        `Set 'include-test-projects: true' or change the 'projects' input.`
      )
    }

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
    core.setOutput('projects-count', analysisResult.projects.length.toString())
    core.setOutput('changed-count', analysisResult.changedProjects.length.toString())
    core.setOutput('summary', analysisResult.summary)
    core.setOutput('version-map', JSON.stringify(versionMap))

    // Single-version outputs come from the first changed project (else the first project)
    const primaryProject = selectPrimaryProject(analysisResult.changedProjects, analysisResult.projects)
    if (primaryProject) {
      const parts = parseVersion(primaryProject.version)
      core.setOutput('version', primaryProject.version)
      core.setOutput('version-project', primaryProject.project)
      if (parts) {
        core.setOutput('major', parts.major)
        core.setOutput('minor', parts.minor)
        core.setOutput('patch', parts.patch)
        core.setOutput('prerelease', parts.prerelease)
      } else {
        core.warning(`Cannot split version '${primaryProject.version}' of ${primaryProject.project} into major/minor/patch`)
        for (const name of ['major', 'minor', 'patch', 'prerelease']) core.setOutput(name, '')
      }
    }

    // Update project properties if requested
    if (updateProjectProperties || writeMrVersionProps) {
      if (dryRun) {
        core.info('[DRY RUN] Would update project properties')
      } else {
        await updateProjects(analysisResult.projects, updateProjectProperties, writeMrVersionProps)
      }
    }

    // Collect validation results
    const validationErrors: Array<{ project: string; errors: ValidationError[] }> = []
    const validationWarnings: Array<{ project: string; warnings: ValidationWarning[] }> = []
    let hasValidationErrors = false
    let hasValidationWarnings = false

    for (const project of results) {
      if (project.validation) {
        if (project.validation.errors && project.validation.errors.length > 0) {
          validationErrors.push({ project: project.project, errors: project.validation.errors })
          hasValidationErrors = true

          // Display errors as GitHub Action annotations
          for (const error of project.validation.errors) {
            core.error(`${project.project}: ${error.message}`, {
              title: 'Version Validation Error',
              file: project.path
            })
          }
        }

        if (project.validation.warnings && project.validation.warnings.length > 0) {
          validationWarnings.push({ project: project.project, warnings: project.validation.warnings })
          hasValidationWarnings = true

          // Display warnings as GitHub Action annotations
          for (const warning of project.validation.warnings) {
            core.warning(`${project.project}: ${warning.message}`, {
              title: 'Version Validation Warning',
              file: project.path
            })
          }
        }
      }
    }

    // Add collapsible summary to job output
    const summary = core.summary.addHeading('📊 Version Calculation Results')

    // Add validation summary if there are issues
    if (hasValidationErrors || hasValidationWarnings) {
      let validationSummary = ''

      if (hasValidationErrors) {
        validationSummary += `### ❌ Validation Errors\n\n`
        for (const { project, errors } of validationErrors) {
          validationSummary += `**${project}:**\n`
          for (const error of errors) {
            validationSummary += `- ❌ ${error.message}\n`
            if (error.expected && error.actual) {
              validationSummary += `  - Expected: \`${error.expected}\`, Actual: \`${error.actual}\`\n`
            }
            if (error.details) {
              validationSummary += `  - ${error.details}\n`
            }
          }
          validationSummary += '\n'
        }
      }

      if (hasValidationWarnings) {
        validationSummary += `### ⚠️ Validation Warnings\n\n`
        for (const { project, warnings } of validationWarnings) {
          validationSummary += `**${project}:**\n`
          for (const warning of warnings) {
            validationSummary += `- ⚠️ ${warning.message}\n`
            if (warning.details) {
              validationSummary += `  - ${warning.details}\n`
            }
          }
          validationSummary += '\n'
        }
      }

      summary.addRaw(validationSummary)
    }

    summary
      .addDetails('📈 Summary',
        `- **Total Projects**: ${analysisResult.projects.length}\n` +
        `- **Projects with Changes**: ${analysisResult.changedProjects.length}\n` +
        `- **Test Projects**: ${results.filter(p => p.isTestProject).length}${!includeTestProjects ? ' (excluded)' : ''}\n` +
        (hasValidationErrors ? `- **Validation Errors**: ❌ ${validationErrors.length} project(s)\n` : '') +
        (hasValidationWarnings ? `- **Validation Warnings**: ⚠️ ${validationWarnings.length} project(s)\n` : '') +
        `- **Repository**: \`${repositoryPath}\`\n` +
        `- **Prerelease Type**: \`${prereleaseType}\`\n` +
        `- **Tag Prefix**: \`${tagPrefix}\`\n` +
        `- **Calculation**: ${CALCULATION_MODES[calculation.mode]}${calculation.reason ? ` (${calculation.reason})` : ''}`
      )
      .addDetails('🔄 Changed Projects',
        analysisResult.changedProjects.length > 0
          ? analysisResult.changedProjects.map(p =>
              `- **${p.project}**: \`${p.version}\` _(${p.changeReason})_${p.validation && !p.validation.isValid ? ' ❌' : ''}`
            ).join('\n')
          : '_No projects have version changes._'
      )
      .addDetails('✅ All Projects',
        analysisResult.projects.map(p =>
          `- **${p.project}**: \`${p.version}\`${p.versionChanged ? ' 🔄' : ''}${p.validation && !p.validation.isValid ? ' ❌' : ''}`
        ).join('\n')
      )

    if (outputVersionInformation) {
      summary
        .addDetails('📋 Detailed Output',
          `\`\`\`${outputFormat}\n${formatSummary(analysisResult, outputFormat)}\n\`\`\``
        )
    }

    await summary.write()

    // Set validation outputs
    core.setOutput('has-validation-errors', hasValidationErrors.toString())
    core.setOutput('has-validation-warnings', hasValidationWarnings.toString())
    core.setOutput('validation-errors-count', validationErrors.length.toString())
    core.setOutput('validation-warnings-count', validationWarnings.length.toString())

    // If there are validation errors, fail the action
    if (hasValidationErrors) {
      core.setFailed(`Version validation failed for ${validationErrors.length} project(s). See annotations for details.`)
      return
    }

    core.info(`✅ Analyzed ${results.length} projects, ${analysisResult.changedProjects.length} with changes`)

  } catch (error) {
    await core.summary
      .addHeading('❌ Version Calculation Failed')
      .addDetails('🐛 Error Details',
        `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``
      )
      .write()

    core.setFailed(`Failed to calculate versions: ${error instanceof Error ? error.message : String(error)}`)
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
  const parts = parseVersion(project.version)
  if (!parts) {
    core.warning(`Cannot parse version ${project.version} for ${project.project}`)
    return
  }

  const { major, minor, patch, prerelease } = parts

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
  const parts = parseVersion(project.version)
  if (!parts) {
    core.warning(`Cannot parse version ${project.version} for ${project.project}`)
    return
  }

  const { major, minor, patch, prerelease } = parts

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