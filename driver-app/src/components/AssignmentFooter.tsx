/**
 * The action dock: the only glass surface at the bottom edge.
 *
 * Holds the single primary action and the three secondary actions, all inside
 * the thumb band. The sheets it opens are the one exception to "one glass
 * surface per edge" — while a sheet is open it owns the bottom edge and this
 * dock is dimmed behind the scrim, never stacked.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { copy } from '../copy';
import { openMaps } from '../maps';
import { useStore } from '../store';
import { colors, contentMaxWidth, radius, spacing, weight } from '../theme';
import { ACTION_LABELS, hasCoordinates, primaryAction, type Trip } from '../types';
import { handoverItems } from '../equipment';
import { BackupSheet } from './BackupSheet';
import { EquipmentCheckSheet } from './EquipmentCheckSheet';
import { GlassSurface } from './Glass';
import { Icon, type IconName } from './Icon';
import { IssueSheet } from './IssueSheet';
import { PrimaryAction } from './PrimaryAction';
import { TransitionCheckSheet } from './TransitionCheckSheet';

interface TripActionsProps {
  trip: Trip;
  /**
   * The route sheet collapses its secondary row at the peek snap, so the
   * primary action keeps the thumb band to itself.
   */
  showSecondary?: boolean;
  /** Rendered beside the primary action — the sheet's expand/collapse control. */
  trailing?: ReactNode;
}

/**
 * The actions themselves, with no surface of their own. Both the full-height
 * dock (Trip screen) and the route sheet (Home) render this, so the two can
 * never drift apart.
 */
export function TripActions({
  trip,
  showSecondary = true,
  trailing,
}: TripActionsProps): React.JSX.Element | null {
  const store = useStore();
  const [issueOpen, setIssueOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);

  const action = primaryAction(trip);
  if (action === null) {
    return null;
  }

  const pending = store.isPending(trip.id);
  const navigable = hasCoordinates(trip);

  const runPrimary = (): void => {
    // Both ends of a response are gated now: the kit before accepting, the
    // handover before closing.
    if (action === 'accept') {
      setCheckOpen(true);
      return;
    }
    if (action === 'complete') {
      setHandoverOpen(true);
      return;
    }
    void store.act(trip);
  };

  const navigate = async (): Promise<void> => {
    const outcome = await openMaps(trip);
    if (outcome === 'unavailable') {
      store.showNotice(copy.noCoordinates, 'error');
      return;
    }
    if (outcome === 'failed') {
      store.showNotice(copy.noMapApp, 'error');
    }
  };

  const copyDestination = async (): Promise<void> => {
    await Clipboard.setStringAsync(trip.destination);
    store.showNotice(copy.destinationCopied);
  };

  const secondary: Array<{ icon: IconName; label: string; onPress: () => void }> = [
    {
      icon: 'nav',
      label: navigable ? copy.navigate : copy.copyDestination,
      onPress: () => {
        if (navigable) {
          void navigate();
        } else {
          void copyDestination();
        }
      },
    },
    { icon: 'alert', label: copy.reportIssue, onPress: () => setIssueOpen(true) },
    { icon: 'plus', label: copy.requestBackup, onPress: () => setBackupOpen(true) },
  ];

  return (
    <View>
      <View style={styles.primaryRow}>
        <View style={styles.grow}>
          <PrimaryAction label={ACTION_LABELS[action]} pending={pending} onPress={runPrimary} />
        </View>
        {trailing}
      </View>

      {showSecondary ? (
        <View style={styles.rail}>
          {secondary.map((item, index) => (
            <Pressable
              accessibilityLabel={item.label}
              accessibilityRole="button"
              key={item.label}
              onPress={item.onPress}
              style={({ pressed }) => [
                styles.segment,
                index > 0 && styles.segmentDivider,
                pressed && styles.segmentPressed,
              ]}
            >
              <View style={styles.well}>
                <Icon color={colors.text} name={item.icon} size={20} />
              </View>
              <Text
                maxFontSizeMultiplier={1.2}
                numberOfLines={1}
                style={styles.segmentLabel}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <IssueSheet
        onClose={() => setIssueOpen(false)}
        onSubmit={async (category, note) => {
          const message = await store.reportIssue(trip, category, note);
          if (message === null) {
            store.showNotice(copy.dispatchNotified);
          }
          return message;
        }}
        visible={issueOpen}
      />

      <BackupSheet
        onClose={() => setBackupOpen(false)}
        onSubmit={async (note) => {
          const message = await store.requestBackup(trip, note);
          if (message === null) {
            store.showNotice(copy.backupNotified);
          }
          return message;
        }}
        visible={backupOpen}
      />

      <EquipmentCheckSheet
        onClose={() => setCheckOpen(false)}
        onConfirm={(note, count) => {
          setCheckOpen(false);
          void store.recordCheck(trip, count, 'equipment', note).then(async () => {
            await store.act(trip);
          });
        }}
        pending={pending}
        trip={trip}
        visible={checkOpen}
      />

      <TransitionCheckSheet
        confirmLabel={copy.complete}
        items={handoverItems()}
        onClose={() => setHandoverOpen(false)}
        onConfirm={() => {
          setHandoverOpen(false);
          void store.recordCheck(trip, handoverItems().length, 'handover').then(async () => {
            await store.act(trip);
          });
        }}
        pending={pending}
        subtitle={`${trip.reference} · ${trip.destination}`}
        title={copy.handoverTitle}
        visible={handoverOpen}
      />
    </View>
  );
}

/** The Trip screen's dock: the actions inside the glass surface. */
export function AssignmentFooter({ trip }: { trip: Trip }): React.JSX.Element | null {
  if (primaryAction(trip) === null) {
    return null;
  }
  return (
    <View style={styles.column}>
      <GlassSurface corner={radius.xxl} shadow="sheet" strong style={styles.dock}>
        <TripActions trip={trip} />
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  dock: {
    padding: spacing.md,
  },
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  grow: {
    flex: 1,
  },
  /**
   * One surface, three equal segments. Three floating labels used to drift out
   * of alignment the moment one of them wrapped; a single rail cannot.
   */
  rail: {
    flexDirection: 'row',
    marginTop: spacing.sm + 2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.inset,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  segmentDivider: {
    borderStartWidth: 1,
    borderStartColor: colors.hairline,
  },
  segmentPressed: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  well: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  segmentLabel: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: weight.medium,
    textAlign: 'center',
  },
});
