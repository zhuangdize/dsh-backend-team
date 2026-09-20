import { EvidenceKind as EvidenceKindSchema, ProjectEvidence as ProjectEvidenceSchema } from './evidence.js'
import type { EvidenceKind as EvidenceKindValue, ProjectEvidence as ProjectEvidenceValue } from './evidence.js'
import { FileIndex as FileIndexImplementation } from './file-index.js'
import type { AuthorizedFileIndexOptions, FileIndexOptions, FileIndexResult, FileIndexWarning, PolicyReadOptions as FileIndexPolicyReadOptions } from './file-index.js'
import { ManifestReader as ManifestReaderImplementation } from './manifest-reader.js'
import type { DataDocument, DocumentFormat, DocumentReadResult, JsonValue, ManifestReadError, ManifestReadResult, ManifestReaderOptions, PackageManifest, PolicyReadOptions as ManifestPolicyReadOptions } from './manifest-reader.js'
import {
  BaselineIssue as BaselineIssueSchema,
  Confidence as ConfidenceSchema,
  DetectedNodeRuntime as DetectedNodeRuntimeSchema,
  DetectedValue as DetectedValueSchema,
  ProjectAnalysisScopeSchema,
  ProjectKind as ProjectKindSchema,
  ProjectProfileSchema,
  ServiceBoundary as ServiceBoundarySchema,
} from './project-profile.js'
import type {
  BaselineIssue as BaselineIssueValue,
  Confidence as ConfidenceValue,
  DetectedNodeRuntime as DetectedNodeRuntimeValue,
  DetectedValue as DetectedValueValue,
  NodeDeclaration,
  ProjectAnalysisScope,
  ProjectKind as ProjectKindValue,
  ProjectProfile,
  ServiceBoundary as ServiceBoundaryValue,
  ServiceBoundaryResolution,
} from './project-profile.js'
import { SecretFilter as SecretFilterImplementation } from './secret-filter.js'

export const EvidenceKind = EvidenceKindSchema
export type EvidenceKind = EvidenceKindValue

export const ProjectEvidence = ProjectEvidenceSchema
export type ProjectEvidence = ProjectEvidenceValue

export const BaselineIssue = BaselineIssueSchema
export type BaselineIssue = BaselineIssueValue

export const Confidence = ConfidenceSchema
export type Confidence = ConfidenceValue

export const DetectedValue = DetectedValueSchema
export type DetectedValue<T extends string> = DetectedValueValue<T>

export const DetectedNodeRuntime = DetectedNodeRuntimeSchema
export type DetectedNodeRuntime = DetectedNodeRuntimeValue

export const ProjectKind = ProjectKindSchema
export type ProjectKind = ProjectKindValue

export { ProjectAnalysisScopeSchema, ProjectProfileSchema }
export type { NodeDeclaration, ProjectAnalysisScope, ProjectProfile }

export const ServiceBoundary = ServiceBoundarySchema
export type ServiceBoundary = ServiceBoundaryValue
export type { ServiceBoundaryResolution }

export const FileIndex = FileIndexImplementation
export type { AuthorizedFileIndexOptions, FileIndexOptions, FileIndexPolicyReadOptions, FileIndexResult, FileIndexWarning }

export const ManifestReader = ManifestReaderImplementation
export type { DataDocument, DocumentFormat, DocumentReadResult, JsonValue, ManifestPolicyReadOptions, ManifestReadError, ManifestReadResult, ManifestReaderOptions, PackageManifest }

export const SecretFilter = SecretFilterImplementation

export { NodeDetector, createDetectorContext } from './detectors/node.js'
export type { Detector, DetectorContext, DetectorContextInput } from './detectors/node.js'
export { NodeRuntimeDetector } from './detectors/node-version.js'
export { PackageManagerDetector } from './detectors/package-manager.js'
export type { PackageManager } from './detectors/package-manager.js'
export { FrameworkDetector } from './detectors/framework.js'
export type { Framework } from './detectors/framework.js'
export { DatabaseDetector } from './detectors/database.js'
export type { Database, DetectedDatabaseStack, Orm } from './detectors/database.js'
export { TestDetector } from './detectors/test.js'
export type { TestRunner } from './detectors/test.js'
export { CommandDetector } from './detectors/command.js'
export type { CommandPurpose, DetectedCommand } from './detectors/command.js'

export { MonorepoAnalyzer } from './monorepo-analyzer.js'
export type { ServiceCandidate } from './monorepo-analyzer.js'
export { ServiceBoundaryResolver } from './service-boundary.js'
export type { ServiceBoundaryCandidate, ServiceBoundaryDecision, ServiceBoundaryResolverOptions } from './service-boundary.js'

export { GitBaseline } from './git-baseline.js'
export type { GitBaselineEntry, GitBaselineOptions, GitBaselineReason, GitBaselineSnapshot, GitChangeState } from './git-baseline.js'
export { VerificationBaseline } from './verification-baseline.js'
export type { ExternalVerificationResult, RecordedVerification, VerificationPlanEntry, VerificationRisk } from './verification-baseline.js'

export { ProjectAnalyzer } from './project-analyzer.js'
export type { ProjectAnalysis, ProjectAnalyzerOptions } from './project-analyzer.js'
export { StrategySelector } from './strategy-selector.js'
export type { ProjectStrategy } from './strategy-selector.js'
