/**
 * Domain views implementation for US2 - Team Lead execution
 *
 * This file implements the UI components that render role-specific views
 * in chat conversations for different business roles.
 */

import React, { useState, useEffect } from 'react';
import {
  ProjectContext,
  RoleViewConfig,
  ArtifactType,
  WorkItem,
  QAReport
} from '../types';

import {
  getProjectArtifacts,
  getWorkItems,
  getQAReports
} from './store';

/**
 * Component to render QA view in chat
 * @param projectContext - Context about the project and requesting member
 * @param workItem - The current work item being viewed
 */
export function QAView({
  projectContext,
  workItem
}: {
  projectContext: ProjectContext;
  workItem: WorkItem;
}): JSX.Element {
  const [qaReport, setQaReport] = useState<QAReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch the QA report for this work item
    const fetchQaReport = async () => {
      try {
        const report = await getQAReports(workItem.id);
        setQaReport(report);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching QA report:', error);
        setLoading(false);
      }
    };

    fetchQaReport();
  }, [workItem.id]);

  if (loading) {
    return <div className="qa-view-loading">Loading QA report...</div>;
  }

  if (!qaReport) {
    return <div className="qa-view-empty">No QA report available</div>;
  }

  return (
    <div className="qa-view">
      <h3>QA Test Results</h3>

      <div className="qa-summary">
        <p><strong>Candidate:</strong> {qaReport.candidateId}</p>
        <p><strong>Test Plan:</strong> {qaReport.testPlanId}</p>
        <p><strong>Pass Percentage:</strong> {qaReport.passPercentage}%</p>
        <p><strong>Status:</strong> {qaReport.outcome}</p>
      </div>

      <div className="qa-scenarios">
        <h4>Test Scenarios:</h4>
        {qaReport.scenarios.map((scenario, index) => (
          <div key={index} className="qa-scenario">
            <p><strong>Scenario {index + 1}:</strong> {scenario.description}</p>
            <p>Status: {scenario.status}</p>
            {scenario.results && (
              <div className="qa-results">
                <p>Expected: {scenario.results.expected}</p>
                <p>Actual: {scenario.results.actual}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {qaReport.finalVerdict && (
        <div className="qa-verdict">
          <h4>Final Verdict:</h4>
          <p>{qaReport.finalVerdict}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Component to render PM view in chat
 * @param projectContext - Context about the project and requesting member
 */
export function PMView({
  projectContext
}: {
  projectContext: ProjectContext;
}): JSX.Element {
  const [changeBrief, setChangeBrief] = useState<ArtifactType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch the Change Brief for this project
    const fetchChangeBrief = async () => {
      try {
        // In a real implementation, this would get the most recent Change Brief
        const artifacts = await getProjectArtifacts(projectContext.projectId, 'ChangeBrief');
        setChangeBrief(artifacts[0] || null);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching Change Brief:', error);
        setLoading(false);
      }
    };

    fetchChangeBrief();
  }, [projectContext.projectId]);

  if (loading) {
    return <div className="pm-view-loading">Loading PM view...</div>;
  }

  if (!changeBrief) {
    return <div className="pm-view-empty">No Change Brief available</div>;
  }

  return (
    <div className="pm-view">
      <h3>Change Brief</h3>

      <div className="change-brief-details">
        <p><strong>Request:</strong> {changeBrief.request}</p>
        <p><strong>Acceptance Criteria:</strong></p>
        <ul>
          {changeBrief.acceptanceCriteria.map((criterion, index) => (
            <li key={index}>{criterion}</li>
          ))}
        </ul>
        <p><strong>Scope:</strong> {changeBrief.scope}</p>
      </div>
    </div>
  );
}

/**
 * Component to render Engineering view in chat
 * @param projectContext - Context about the project and requesting member
 */
export function EngineeringView({
  projectContext
}: {
  projectContext: ProjectContext;
}): JSX.Element {
  const [candidate, setCandidate] = useState<ArtifactType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch the Candidate for this project
    const fetchCandidate = async () => {
      try {
        // In a real implementation, this would get the most recent Candidate
        const artifacts = await getProjectArtifacts(projectContext.projectId, 'Candidate');
        setCandidate(artifacts[0] || null);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching Candidate:', error);
        setLoading(false);
      }
    };

    fetchCandidate();
  }, [projectContext.projectId]);

  if (loading) {
    return <div className="engineering-view-loading">Loading Engineering view...</div>;
  }

  if (!candidate) {
    return <div className="engineering-view-empty">No Candidate available</div>;
  }

  return (
    <div className="engineering-view">
      <h3>Candidate Details</h3>

      <div className="candidate-details">
        <p><strong>Source Revision:</strong> {candidate.sourceRevision}</p>
        <p><strong>Status:</strong> {candidate.status}</p>
        <p><strong>Change Brief:</strong> {candidate.changeBrief}</p>
      </div>
    </div>
  );
}

/**
 * Component to render Team Lead view in chat
 * @param projectContext - Context about the project and requesting member
 */
export function TeamLeadView({
  projectContext,
  workItems
}: {
  projectContext: ProjectContext;
  workItems: WorkItem[];
}): JSX.Element {
  return (
    <div className="team-lead-view">
      <h3>Team Lead Dashboard</h3>

      <div className="work-items-summary">
        <p><strong>Active Work Items:</strong> {workItems.length}</p>
        <div className="work-item-list">
          {workItems.map((item, index) => (
            <div key={index} className="work-item">
              <p><strong>Role:</strong> {item.role}</p>
              <p><strong>Status:</strong> {item.status}</p>
              <p><strong>Action:</strong> {item.action}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="decisions-summary">
        <h4>Pending Decisions:</h4>
        {/* In a real implementation, this would show actual pending decisions */}
        <p>No pending decisions currently</p>
      </div>
    </div>
  );
}

/**
 * Main domain views component that renders the appropriate view based on role
 * @param projectContext - Context about the project and requesting member
 * @param role - The role view to render (QA, PM, Engineering, Team Lead)
 * @param workItem - The current work item being viewed (if applicable)
 */
export function DomainView({
  projectContext,
  role,
  workItem
}: {
  projectContext: ProjectContext;
  role: string;
  workItem?: WorkItem;
}): JSX.Element {
  switch (role) {
    case 'QA':
      return <QAView projectContext={projectContext} workItem={workItem || { id: '' } as WorkItem} />;
    case 'Product Manager':
      return <PMView projectContext={projectContext} />;
    case 'Software Engineer':
      return <EngineeringView projectContext={projectContext} />;
    case 'Team Lead':
      // In a real implementation, this would get actual work items
      return <TeamLeadView projectContext={projectContext} workItems={[]} />;
    default:
      return <div className="domain-view-error">Unknown role view: {role}</div>;
  }
}

// Export all components
export {
  QAView,
  PMView,
  EngineeringView,
  TeamLeadView,
  DomainView
};
