import { inject, injectable } from 'inversify';
import type { NonEmptyArray } from 'ts-essentials';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import {
  isCommercialLineupItem,
  isProgramLineupItem,
} from '../db/derived_types/StreamLineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import { CelEvaluationService } from '../services/CelEvaluationService.ts';
import { StreamSelectionProfileResolver } from '../services/StreamSelectionProfileResolver.ts';
import type {
  AudioStreamDetails,
  SubtitleStreamDetails,
} from '../stream/types.ts';
import {
  buildCelContext,
  evaluateStreamSelectionProfile,
} from './StreamSelectionEvaluator.ts';

type StreamSelectRequest = {
  channel: ChannelOrm;
  lineupItem: ContentBackedStreamLineupItem;
  audioStreams: NonEmptyArray<AudioStreamDetails>;
  subtitleStreams: Array<SubtitleStreamDetails>;
};

@injectable()
export class StreamSelector {
  constructor(
    @inject(StreamSelectionProfileResolver)
    private streamSelectionResolver: StreamSelectionProfileResolver,
    @inject(CelEvaluationService) private celService: CelEvaluationService,
  ) {}

  async selectAudioAndSubtitleStreams(request: StreamSelectRequest) {
    return this.selectStreams(request, false);
  }

  async selectAudioStream(
    request: StreamSelectRequest,
  ): Promise<AudioStreamDetails> {
    const { audioStream } = await this.selectStreams(request, true);
    return audioStream;
  }

  private async selectStreams(
    { channel, lineupItem, audioStreams, subtitleStreams }: StreamSelectRequest,
    audioOnly: boolean,
  ) {
    const selectionCtx = {
      channelId: channel.uuid,
      programId: lineupItem.program.uuid,
      fillerListId: isCommercialLineupItem(lineupItem)
        ? lineupItem.fillerListId
        : undefined,
      customShowId: isProgramLineupItem(lineupItem)
        ? lineupItem.customShowId
        : undefined,
    };

    const profile = await this.streamSelectionResolver.resolve(selectionCtx);
    // Audio rules may depend on subtitle availability. Keep that context even
    // when the caller only wants audio and handles subtitle selection elsewhere.
    const celContext = buildCelContext(
      audioStreams,
      subtitleStreams,
      { name: channel.name, number: channel.number },
      { title: lineupItem.program.title, type: lineupItem.program.type },
    );

    return await evaluateStreamSelectionProfile(
      profile,
      audioStreams,
      subtitleStreams,
      this.celService,
      celContext,
      lineupItem,
      { audioOnly },
    );
  }
}
