'use client';

import { useState, useEffect } from 'react';
import { PageShell } from '@/components/page-shell';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { listProjectsAction } from './actions';

interface Project {
  id: number;
  slug: string;
  name: string;
  status: string | null;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadProjects = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listProjectsAction();
      if (result.success && result.data) {
        setProjects(result.data.projects);
      } else {
        setError(result.error || 'Failed to load projects');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.slug.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <PageShell title="Projects">
      <div className="space-y-4">
        <div className="flex gap-3">
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-sm"
          />
          <Button onClick={() => setCreateDialogOpen(true)}>Create Project</Button>
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        {loading ? (
          <div className="text-sm text-muted-foreground">Loading projects...</div>
        ) : filteredProjects.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects found</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => (
              <Card key={project.id} className="p-4">
                <div className="space-y-2">
                  <h3 className="font-semibold">{project.name}</h3>
                  <p className="text-sm text-muted-foreground">{project.slug}</p>
                  {project.status && (
                    <div>
                      <Badge variant="outline">{project.status}</Badge>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSuccess={loadProjects}
      />
    </PageShell>
  );
}
