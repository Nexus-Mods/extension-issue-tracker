import { setUpdateDetails, updateIssueList } from './actions';
import { IGithubIssue, IGithubIssueCache, IGithubComment } from './IGithubIssue';

import * as Promise from 'bluebird';
import { IncomingMessage } from 'http';
import { get } from 'https';
import { IIssue } from 'nexus-api';
import * as React from 'react';
import { Button } from 'react-bootstrap';
import * as ReactDOM from 'react-dom';
import { translate } from 'react-i18next';
import { connect } from 'react-redux';
import * as url from 'url';
import { ComponentEx, Dashlet, log, Spinner, tooltip, types, util } from 'vortex-api';
import * as va from 'vortex-api';

const { EmptyPlaceholder } = va as any;

const UPDATE_FREQUENCY = 24 * 60 * 60 * 1000;

function queryIssues(api: types.IExtensionApi): Promise<IIssue[]> {
  return new Promise((resolve, reject) => {
    api.events.emit('request-own-issues', (err: Error, issues: IIssue[]) => {
      if (err !== null) {
        return reject(err);
      }
      resolve(issues);
    });
  });
}

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
  private static GITHUB_PROJ = 'Nexus-Mods/Vortex';
  private static DUPLICATE_EXP = /[ ]*duplicate of #([0-9]+)[ ]*/;
  // hide closed issues without any update after a month
  private static HIDE_AFTER = 30 * 24 * 60 * 60 * 1000;
  constructor(props: IProps) {
    super(props);

    this.initState({
      updating: false,
    });
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
          },
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

    const now = Date.now();

    const sorted = Object.keys(issues)
      .filter(id => (issues[id].state !== 'closed')
                 || (now - issues[id].closedTime < IssueList.HIDE_AFTER)
                 || (now - issues[id].lastUpdated < IssueList.HIDE_AFTER))
      .sort((lhs, rhs) => issues[rhs].lastUpdated - issues[lhs].lastUpdated)
      .map(id => this.renderIssue(issues[id]));

    return (
      <div className='list-issues'>
        {sorted}
      </div>
    );
  }

  private openIssue = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    evt.preventDefault();
    const issueId = evt.currentTarget.getAttribute('data-issue');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/issues/${issueId}`);
  }

  private openMilestone = (evt: React.MouseEvent<Button>) => {
    evt.preventDefault();
    const node: Element = ReactDOM.findDOMNode(evt.currentTarget) as Element;
    const milestoneId = node.getAttribute('data-milestone');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/milestone/${milestoneId}`);
  }

  private issueURL(issueId: string): string {
    return `https://api.github.com/repos/${IssueList.GITHUB_PROJ}/issues/${issueId}`;
  }

  private requestFromApi(apiURL: string): Promise<any> {
    return new Promise((resolve, reject) => {
      get({
        ...url.parse(apiURL),
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

  private requestIssue(issueId: string): Promise<IGithubIssue> {
    return this.requestFromApi(this.issueURL(issueId))
    .then((issue: IGithubIssue) =>
      // if the issue is labeled a duplicate, show the referenced issue
      // instead
      (issue.labels.find(label => label.name === 'duplicate') !== undefined)
        ? this.followDuplicate(issue)
        : issue);
  }

  private followDuplicate(issue: IGithubIssue): Promise<IGithubIssue> {
    return this.requestFromApi(issue.comments_url)
      .then((comments: IGithubComment[]) => {
        const redir = comments.reverse().find(comment => IssueList.DUPLICATE_EXP.test(comment.body));
        if (redir === undefined) {
          // if there is no comment saying what this is a duplicate of, show the original issue after all
          return issue;
        } else {
          // extract the referenced id and return that issue
          const refId = IssueList.DUPLICATE_EXP.exec(redir.body)[1];
          return this.requestIssue(refId);
        }
      });
  }

  private cache(input: IGithubIssue): IGithubIssueCache {
    return {
      number: input.number,
      closedTime: Date.parse(input.closed_at),
      createdTime: Date.parse(input.created_at),
      comments: input.comments,
      labels: input.labels.map(label => label.name),
      state: input.state,
      title: input.title,
      body: input.body,
      user: input.user !== undefined ? input.user.login : undefined,
      lastUpdated: Date.parse(input.updated_at),
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
    queryIssues(this.context.api)
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
        log('warn', 'Failed to get list of issues', err);
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

function mapDispatchToProps(dispatch: any): IActionProps {
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
