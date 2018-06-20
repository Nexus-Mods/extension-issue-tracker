import { updateIssueList, setUpdateDetails } from './actions';
import { IGithubIssue, IGithubIssueCache } from './IGithubIssue';

import * as Promise from 'bluebird';
import { IncomingMessage } from 'http';
import { get } from 'https';
import { IIssue } from 'nexus-api';
import opn = require('opn');
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { translate } from 'react-i18next';
import { connect } from 'react-redux';
import * as Redux from 'redux';
import * as url from 'url';
import { ComponentEx, Dashlet, Icon, log, Spinner, tooltip } from 'vortex-api';
import * as va from 'vortex-api';
import { Button } from 'react-bootstrap';

const { EmptyPlaceholder } = va as any;

const UPDATE_FREQUENCY = 24 * 60 * 60 * 1000;

interface IConnectedProps {
  issues: { [id: string]: IGithubIssueCache };
}

interface IActionProps {
  onUpdateIssueList: (issueIds: string[]) => void;
  onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IIssueListState {
  updating: boolean;
}

class IssueList extends ComponentEx<IProps, IIssueListState> {
  constructor(props: IProps) {
    super(props);

    this.initState({
      updating: false,
    })
  }

  public componentWillMount() {
    this.updateIssues(false);
  }

  public render(): JSX.Element {
    const { t, issues } = this.props;

    return (
      <Dashlet className='dashlet-issues' title={t('Your issues')}>
        <tooltip.IconButton
          className='issues-refresh'
          icon='refresh'
          tooltip={t('Refresh Issues')}
          onClick={this.refresh}
        />
        <div className='list-issues-container'>
          {this.renderIssues(issues)}
        </div>
      </Dashlet>
    );
  }

  private renderPleaseWait() {
    return <Spinner />;
  }

  private renderNoIssues() {
    const { t } = this.props;
    return (
      <EmptyPlaceholder
        icon='layout-list'
        text={t('No reported issues')}
        subtext={t('Lucky you...')}
      />
    );
  }

  private renderLabel(label: string): JSX.Element {
    const { t } = this.props;
    if (label === 'bug') {
      return <tooltip.Icon key='bug' name='bug' tooltip={t('Bug')} />;
    } else if (label === 'help wanted') {
      return (
        <tooltip.Icon
          key='help wanted'
          name='attention-required'
          tooltip={t('Feedback required')}
        />);
    } else {
      return null;
    }
  }

  private renderMilestone(issue: IGithubIssueCache): JSX.Element {
    const { t } = this.props;

    if (issue.milestone === undefined) {
      return null;
    }

    const completion = issue.milestone.closed_issues
      / (issue.milestone.closed_issues + issue.milestone.open_issues);

    const state = issue.milestone.state === 'closed'
      ? t('Closed')
      : t('{{completion}}%, planned for {{date}}', {
        replace: {
          completion: completion * 100,
          date: new Date(issue.milestone.due_on).toLocaleDateString(this.context.api.locale()),
        } });

    return (
      <tooltip.IconButton
        className='issue-milestone-button'
        data-milestone={issue.milestone.number.toString()}
        onClick={this.openMilestone}
        icon='milestone'
        tooltip={t('Milestone: {{title}} ({{state}})', {
          replace: {
            title: issue.milestone.title,
            state,
          }
        })}
      />
    );
  }

  private renderIssue = (issue: IGithubIssueCache) => {
    const { t } = this.props;
    if (issue.number === undefined) {
      return null;
    }
    return (
      <div key={issue.number.toString()} className='issue-item'>
        <div className='issue-item-number'>{`#${issue.number}`}</div>
        <div className='issue-item-state'>
          {issue.state === 'open' ? t('Open') : t('Closed')}
          {this.renderMilestone(issue)}
        </div>
        <div className='issue-item-labels'>
          {issue.labels.map(label => this.renderLabel(label))}
        </div>
        <div className='issue-item-title'>
          <a
            data-issue={issue.number.toString()}
            title={issue.body}
            onClick={this.openIssue}
          >
            {issue.title}
          </a>
        </div>
        <div className='issue-item-comments'>
          {t('{{ count }} comments', { count: issue.comments })}
        </div>
      </div>
    );
  }

  private renderIssues(issues: { [id: string]: IGithubIssueCache }) {
    const { updating } = this.state;
    if (updating) {
      return this.renderPleaseWait();
    }
    if (Object.keys(issues).length === 0) {
      return this.renderNoIssues();
    }

    return (
      <div className='list-issues'>
        {Object.keys(issues).map(id => this.renderIssue(issues[id]))}
      </div>
    );
  }

  private openIssue = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    evt.preventDefault();
    const issueId = evt.currentTarget.getAttribute('data-issue');
    opn(`https://github.com/vortex-reporter/test-proj/issues/${issueId}`);
  }

  private openMilestone = (evt: React.MouseEvent<Button>) => {
    evt.preventDefault();
    const node: Element = ReactDOM.findDOMNode(evt.currentTarget) as Element;
    const milestoneId = node.getAttribute('data-milestone');
    opn(`https://github.com/vortex-reporter/test-proj/milestone/${milestoneId}`);
  }

  private issueURL(issueId: string): string {
    const res = `https://api.github.com/repos/vortex-reporter/test-proj/issues/${issueId}`;
    console.log('url', res);
    return res;
  }

  private requestIssue(issueId: string): Promise<IGithubIssue> {
    return new Promise((resolve, reject) => {
      get({
        ...url.parse(this.issueURL(issueId)),
        headers: { 'User-Agent': 'Vortex' },
      } as any, (res: IncomingMessage) => {
        const { statusCode } = res;
        const contentType = res.headers['content-type'];

        let err: string;
        if (statusCode !== 200) {
          err = `Request Failed. Status Code: ${statusCode}`;
        } else if (!/^application\/json/.test(contentType)) {
          err = `Invalid content-type ${contentType}`;
        }

        if (err !== undefined) {
          res.resume();
          return reject(new Error(err));
        }

        res.setEncoding('utf8');
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(rawData));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', (err: Error) => {
        return reject(err);
      });
    });
  }

  private cache(input: IGithubIssue): IGithubIssueCache {
    return {
      number: input.number,
      closedTime: input.closed_at,
      createdTime: input.created_at,
      comments: input.comments,
      labels: input.labels.map(label => label.name),
      state: input.state,
      title: input.title,
      body: input.body,
      user: input.user !== undefined ? input.user.login : undefined,
      lastUpdated: Date.now(),
      milestone: input.milestone !== null ? {
        number: input.milestone.number,
        title: input.milestone.title,
        state: input.milestone.state,
        closed_issues: input.milestone.closed_issues,
        open_issues: input.milestone.open_issues,
        due_on: input.milestone.due_on,
      } : undefined,
    };
  }

  private refresh = () => {
    this.updateIssues(true);
  }

  private updateIssues(force: boolean) {
    const { issues, onSetUpdateDetails, onUpdateIssueList } = this.props;
    this.nextState.updating = true;
    (this.context.api as any).invoke('request-own-issues')
      .then((res: Array<{ issue_number: number }>) => {
        onUpdateIssueList(res.map(issue => issue.issue_number.toString()));
        const now = Date.now();
        return Promise.map(res.map(issue => issue.issue_number.toString()), issueId => {
          if (force
            || (issues[issueId] === undefined)
            || (issues[issueId].lastUpdated === undefined)
            || ((now - issues[issueId].lastUpdated) > UPDATE_FREQUENCY)) {
            return this.requestIssue(issueId)
              .then(issue => {
                onSetUpdateDetails(issueId, this.cache(issue));
              })
              .catch(err => {
                log('warn', 'Failed to retrieve github issue', err);
              });
          }
        });
      })
      .catch(err => {
        // probably a network error, but this isn't really a big deal
        log('warn', 'Failed to get list of issues' ,err);
      })
      .finally(() => {
        this.nextState.updating = false;
      });
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    issues: state.persistent.issues.issues,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onUpdateIssueList: (issueIds: string[]) => dispatch(updateIssueList(issueIds)),
    onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) =>
      dispatch(setUpdateDetails(issueId, details)),
  };
}

export default
  connect(mapStateToProps, mapDispatchToProps)(
    translate(['issue-tracker', 'common'], { wait: true })(
      IssueList));
