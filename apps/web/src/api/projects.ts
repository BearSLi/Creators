import { api, buildParams } from './client';
import type {
  CreateProjectRequest,
  Paginated,
  ProjectDetail,
  ProjectListQuery,
  ProjectListItem,
  UpdateProjectRequest,
} from './types';

/** 项目接口：一个项目对应一次品牌投放，下面挂多条内容。 */

export function listProjects(query: ProjectListQuery): Promise<Paginated<ProjectListItem>> {
  return api.get<Paginated<ProjectListItem>>('/projects', buildParams(query));
}

export function getProject(id: string): Promise<ProjectDetail> {
  return api.get<ProjectDetail>(`/projects/${id}`);
}

export function createProject(body: CreateProjectRequest): Promise<ProjectDetail> {
  return api.post<ProjectDetail>('/projects', body);
}

export function updateProject(id: string, body: UpdateProjectRequest): Promise<ProjectDetail> {
  return api.patch<ProjectDetail>(`/projects/${id}`, body);
}

export function deleteProject(id: string): Promise<{ id: string; deleted: true }> {
  return api.delete<{ id: string; deleted: true }>(`/projects/${id}`);
}
