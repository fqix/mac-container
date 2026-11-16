import * as assert from 'assert';

import {kindOf} from '../../src/services/k8s';
import {
  hasTemplate,
  k8sTemplate,
  TEMPLATE_RESOURCES,
} from '../../src/services/k8sTemplates';

describe('k8s templates', () => {
  it('has a template for each offered kind, in the view catalog', () => {
    for (const resource of TEMPLATE_RESOURCES) {
      assert.ok(kindOf(resource), resource);
      assert.ok(hasTemplate(resource));
    }
    assert.ok(!hasTemplate('events'));
    assert.ok(!hasTemplate('persistentvolumes'));
  });

  it('names the kind and puts namespaced objects in the namespace', () => {
    for (const resource of TEMPLATE_RESOURCES) {
      const yaml = k8sTemplate(resource, 'team-a');
      const singular = kindOf(resource)!.label.replace(/(e?s)$/, '');
      assert.match(yaml, /^apiVersion: \S+\nkind: \S+\nmetadata:\n/, resource);
      assert.ok(
        yaml.toLowerCase().includes(`kind: ${singular.toLowerCase()}`) ||
          (resource === 'ingresses' && yaml.includes('kind: Ingress')) ||
          (resource === 'namespaces' && yaml.includes('kind: Namespace')),
        resource,
      );
      if (resource === 'namespaces') {
        assert.ok(!yaml.includes('namespace:'), resource);
      } else {
        assert.ok(yaml.includes('  namespace: team-a\n'), resource);
      }
      // YAML indentation: spaces only, in steps of two
      for (const line of yaml.split('\n')) {
        assert.ok(!line.includes('\t'), `${resource}: ${line}`);
        assert.strictEqual(
          (line.match(/^ */)?.[0].length ?? 0) % 2,
          0,
          `${resource}: ${line}`,
        );
      }
      assert.ok(yaml.endsWith('\n'), resource);
    }
  });

  it('selects the pods its workloads create', () => {
    const deployment = k8sTemplate('deployments', 'default');
    assert.match(deployment, /matchLabels:\n\s+app: my-app/);
    assert.match(deployment, /labels:\n\s+app: my-app/);
  });
});
