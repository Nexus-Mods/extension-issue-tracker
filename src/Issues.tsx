import { setUpdateDetails, updateIssueList } from './actions/persistent';
import { openFeedbackResponder, setOutstandingIssues } from './actions/session';

import { IGithubComment, IGithubIssue, IGithubIssueCache } from './IGithubIssue';

import { IOutstandingIssue } from './types';

import { IIssue } from '@nexusmods/nexus-api';
import Promise from 'bluebird';

import * as React from 'react';
import { Button } from 'react-bootstrap';
import * as ReactDOM from 'react-dom';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';

import { actions, ComponentEx, Dashlet, log, Spinner, tooltip, types, util } from 'vortex-api';
import * as va from 'vortex-api';

import { cacheEntry, getLastDevComment,
  isFeedbackRequiredLabel, requestFromApi } from './util';

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
  outstandingIssues: IOutstandingIssue[];
}

interface IActionProps {
  onUpdateIssueList: (issueIds: string[]) => void;
  onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) => void;
  onShowDialog: (type: types.DialogType, title: string, content: types.IDialogContent,
                 actions: types.DialogActions) => void;
  onOpenFeedbackResponder: (open: boolean) => void;
  onSetOustandingIssues: (issues: IOutstandingIssue[]) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IIssueListState {
  updating: boolean;
}

class IssueList extends ComponentEx<IProps, IIssueListState> {
  private static GITHUB_PROJ = 'Nexus-Mods/Vortex';
  private static DUPLICATE_EXP = /[ ]*duplicate of #([0-9]+)[ ]*/i;
  // hide closed issues without any update after a month
  private static HIDE_AFTER = 30 * 24 * 60 * 60 * 1000;
  // allow refresh once every minute. This is mostly to prevent people from spamming the button
  private static MIN_REFRESH_DELAY = 60 * 1000;
  private mMounted: boolean = false;
  private mLastRefresh: number = 0;

  constructor(props: IProps) {
    super(props);

    this.initState({
      updating: false,
    });
  }

  public UNSAFE_componentWillMount() {
    this.updateIssues(false);
  }

  public componentDidMount() {
    this.mMounted = true;
  }

  public componentWillUnmount() {
    this.mMounted = false;
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
        <tooltip.IconButton
          className='issues-responder'
          icon='feedback'
          tooltip={t('Issue Responder')}
          onClick={this.openResponder}
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
    } else if (isFeedbackRequiredLabel(label)) {
      return (
        <tooltip.Icon
          key='help wanted'
          name='attention-required'
          tooltip={t('Feedback required')}
        />
      );
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
      : t('{{completion}}%{{planned}}', {
        replace: {
          completion: Math.floor(completion * 100),
          planned: issue.milestone.due_on === null ? '' :
            t(', planned for {{date}}', {
              replace: {
                date: new Date(issue.milestone.due_on)
                  .toLocaleDateString(this.context.api.locale()),
              },
            }),
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
    if (issue?.number === undefined) {
      return null;
    }

    // Find all labels that require feedback from the reporter/user
    const feedbackRequiredLabels =
      issue.labels.filter(label => isFeedbackRequiredLabel(label));

    return (
      <div key={issue.number.toString()} className='issue-item'>
        <div className='issue-item-number'>{`#${issue.number}`}</div>
        <div className='issue-item-state'>
          {issue.state === 'open' ? t('Open') : t('Closed')}
          {this.renderMilestone(issue)}
        </div>
        <div className='issue-item-labels'>
          {issue.labels.map(label => isFeedbackRequiredLabel(label)
            ? null
            : this.renderLabel(label))}
          {feedbackRequiredLabels.length > 0 ? this.renderLabel(feedbackRequiredLabels[0]) : null}
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

    const now = Date.now();

    const sorted = Object.keys(issues)
      .filter(id => (issues[id].state !== 'closed')
                 || (now - issues[id].closedTime < IssueList.HIDE_AFTER)
                 || (now - issues[id].lastUpdated < IssueList.HIDE_AFTER))
      .sort((lhs, rhs) => issues[rhs].lastUpdated - issues[lhs].lastUpdated);

    const distinct = [].concat([...new Set(sorted.map(id => {
      // We don't want to show the user the same issue twice.
      //  If he created 2 issues and one has been labeled a duplicate
      //  of the other, we're going to ensure we filter out the duplicate.
      const targetNumber = issues[id].number;
      return (issues[targetNumber]?.number !== undefined)
        ? targetNumber : id;
    }))]);

    if (Object.keys(distinct).length === 0) {
      return this.renderNoIssues();
    }

    return (
      <div className='list-issues'>
        {distinct.map(id => this.renderIssue(issues[id]))}
      </div>
    );
  }

  private openIssue = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    evt.preventDefault();
    const issueId = evt.currentTarget.getAttribute('data-issue');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/issues/${issueId}`)
      .catch(() => null);
  }

  private openMilestone = (evt: React.MouseEvent<Button>) => {
    evt.preventDefault();
    const node: Element = ReactDOM.findDOMNode(evt.currentTarget) as Element;
    const milestoneId = node.getAttribute('data-milestone');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/milestone/${milestoneId}`)
      .catch(() => null);
  }

  private issueURL(issueId: string): string {
    return `https://api.github.com/repos/${IssueList.GITHUB_PROJ}/issues/${issueId}`;
  }

  private requestIssue(issueId: string): Promise<IGithubIssue> {
    return requestFromApi(this.issueURL(issueId))
    .then((issue: IGithubIssue) =>
      // if the issue is labeled a duplicate, show the referenced issue
      // instead
      (issue.labels.find(label => label.name === 'duplicate') !== undefined)
        ? this.followDuplicate(issue)
        : issue);
  }

  private followDuplicate(issue: IGithubIssue): Promise<IGithubIssue> {
    return requestFromApi(issue.comments_url)
      .then((comments: IGithubComment[]) => {
        const redir = comments.reverse()
          .find(comment => IssueList.DUPLICATE_EXP.test(comment.body));
        if (redir === undefined) {
          // if there is no comment saying what this is a duplicate of,
          // show the original issue after all
          return issue;
        } else {
          // extract the referenced id and return that issue
          const refId = IssueList.DUPLICATE_EXP.exec(redir.body)[1];
          return this.requestIssue(refId);
        }
      });
  }

  private refresh = () => {
    this.updateIssues(true);
  }

  private openResponder = () => {
    const { onOpenFeedbackResponder, outstandingIssues } = this.props;
    if (outstandingIssues.length === 0) {
      this.updateIssues(true);
    }
    onOpenFeedbackResponder(true);
  }

  private updateIssues(force: boolean) {
    const { t, issues, onOpenFeedbackResponder, onSetUpdateDetails,
            onSetOustandingIssues, onUpdateIssueList } = this.props;
    if (Date.now() - this.mLastRefresh < IssueList.MIN_REFRESH_DELAY) {
      return;
    }
    if (this.mMounted) {
      this.nextState.updating = true;
    }
    this.mLastRefresh = Date.now();
    queryIssues(this.context.api)
      .then((res: Array<{ issue_title: string, issue_number: number }>) => {
        const filteredRes = res.filter(issue => !issue.issue_title.startsWith('Response to #'));
        onUpdateIssueList(filteredRes.map(issue => issue.issue_number.toString()));
        const now = Date.now();
        const outstanding: IOutstandingIssue[] = [];
        return Promise.mapSeries(filteredRes.map(issue =>
          issue.issue_number.toString()), issueId => {
          if (force
              || (issues[issueId] === undefined)
              || (issues[issueId].cacheTime === undefined)
              || ((now - issues[issueId].cacheTime) > UPDATE_FREQUENCY)) {
            return this.requestIssue(issueId)
              .then(issue => {
                const lastCommentResponseMS = util.getSafe(issues,
                  [issueId, 'lastCommentResponseMS'], 0);
                const replyRequired = issue.labels.find(lbl =>
                  isFeedbackRequiredLabel(lbl.name)) !== undefined;

                const isClosed = issue.state === 'closed';

                return getLastDevComment(issue)
                  .then((comment: IGithubComment) => {
                    if (comment !== undefined) {
                      const commentDate = new Date(comment.updated_at);
                      if (replyRequired
                      && !isClosed
                      && (lastCommentResponseMS < commentDate.getTime())
                      && (outstanding.find(out => out.issue.number === issue.number) === undefined)) {
                        // Only add this if we confirm that:
                        //  1. The waiting for response label is set.
                        //  2. The issue is still open.
                        //  3. The latest comment's date is more recent than the date of the
                        //     comment to which the user has responded last.
                        //  4. The issue number isn't already added in the outstanding list.
                        //     This will happen if the user had opened 2 different issues and
                        //      we closed one of them as a duplicate of the other.
                        outstanding.push({ issue, lastDevComment: comment });
                      }
                    }

                    onSetUpdateDetails(issueId, cacheEntry(issue, lastCommentResponseMS));
                    return Promise.resolve();
                  });
              });
          }
        })
        .then(() => {
          if (outstanding.length > 0) {
            onOpenFeedbackResponder(true);
            onSetOustandingIssues(outstanding);
          }
        })
        .catch(err => {
          if (err.message.includes('Status Code: 403') && force) {
            this.context.api.sendNotification({
              message: t('Sent too many github API requests - try again later'),
              type: 'info',
              displayMS: 3000,
            });
          }
          log('warn', 'Failed to retrieve github issues', err);
        });
      })
      .catch(err => {
        if (err instanceof util.ProcessCanceled) {
          log('debug', 'Failed to get list of issues', err.message);
        }
        // probably a network error, but this isn't really a big deal
        log('warn', 'Failed to get list of issues', err);
      })
      .finally(() => {
        if (this.mMounted) {
          this.nextState.updating = false;
        }
      });
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    outstandingIssues: util.getSafe(state, ['session', 'issues', 'oustandingIssues'], []),
    issues: state.persistent.issues.issues,
  };
}

function mapDispatchToProps(dispatch: any): IActionProps {
  return {
    onUpdateIssueList: (issueIds: string[]) => dispatch(updateIssueList(issueIds)),
    onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) =>
      dispatch(setUpdateDetails(issueId, details)),
    onShowDialog: (type, title, content, dialogActions) =>
      dispatch(actions.showDialog(type, title, content, dialogActions)),
    onOpenFeedbackResponder: (open: boolean) =>
      dispatch(openFeedbackResponder(open)),
    onSetOustandingIssues: (issues: IOutstandingIssue[]) =>
      dispatch(setOutstandingIssues(issues)),
  };
}

export default
  connect(mapStateToProps, mapDispatchToProps)(
    withTranslation(['issue-tracker', 'common'])(
      IssueList as any)) as any;
