'use server';

import { listProjects as coreListProjects, createProject as coreCreateProject, getProject as coreGetProject } from '@apotheosis/core';

export async function listProjectsAction() {
  try {
    const result = coreListProjects();
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list projects',
    };
  }
}

export async function createProjectAction(args: {
  slug: string;
  name: string;
  description?: string;
}) {
  try {
    const result = coreCreateProject(args);
    if ('error' in result) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create project',
    };
  }
}

export async function getProjectAction(slug: string) {
  try {
    const result = coreGetProject({ slug });
    if ('error' in result) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get project',
    };
  }
}
