import Issues from './Issues';
import persistentReducer from './reducers';

import * as path from 'path';
import { types } from 'vortex-api';

function main(context: types.IExtensionContext) {
  context.registerDashlet('Issues', 1, 2, 200, Issues, () => true,
  () => ({}), { closable: true });

  context.registerReducer(['persistent', 'issues'], persistentReducer);

  context.once(() => {
    context.api.setStylesheet('issue-tracker',
      path.join(__dirname, 'issue_tracker.scss'));
  });

  return true;
}

export default main;
