/**
 * Profile: identity, this shift, security, dispatch.
 *
 * This absorbs the old Settings screen. Everything that used to hide behind a
 * gear icon is on the surface now, one scroll from the dock.
 */

import Constants from 'expo-constants';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { apiBaseHost } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { PageHead } from '../components/PageHead';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { TabDock } from '../components/TabDock';
import { TopBar, availabilityLabel } from '../components/TopBar';
import { copy } from '../copy';
import { checkExpiresAt, checkIsFresh } from '../equipment';
import { formatClock, formatServerClock, vehicleTypeLabel } from '../format';
import { useStore } from '../store';
import {
  colors,
  contentMaxWidth,
  radius,
  spacing,
  tabular,
  type as typeScale,
  weight,
} from '../theme';

function Row({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: IconName;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text maxFontSizeMultiplier={1.3} style={styles.rowLabel}>
        {label}
      </Text>
      <View style={styles.rowValueWrap}>
        {icon === undefined ? null : <Icon color={colors.secondary} name={icon} size={15} />}
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.rowValue, tabular]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text maxFontSizeMultiplier={1.2} style={styles.statValue}>
        {value}
      </Text>
      <Text maxFontSizeMultiplier={1.2} style={styles.statLabel}>
        {label}
      </Text>
    </View>
  );
}

export function ProfileScreen(): React.JSX.Element {
  const store = useStore();
  const [fingerprint, setFingerprint] = useState(true);
  const [requirePin, setRequirePin] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const lastSync = formatServerClock(store.serverTime) ?? copy.notSynced;
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const responses = store.queueCount + (store.assignment === null ? 0 : 1);

  return (
    <Screen
      aura
      footer={
        <TabDock
          active="profile"
          onSelect={(tab) => {
            store.switchTab({ name: tab });
          }}
        />
      }
      pill={
        <TopBar
          caption={`${availabilityLabel(store.availability)} · ${vehicleTypeLabel(
            store.vehicleType
          )}`}
          title={store.callSign ?? copy.notPaired}
          tone={store.availability}
        />
      }
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.column}>
          <PageHead subtitle={vehicleTypeLabel(store.vehicleType)} title={copy.profile} />

          <View style={styles.identity}>
            <View style={styles.avatar}>
              <Icon color={colors.accent} name="ambulance" size={26} />
            </View>
            <View style={styles.grow}>
              <Text maxFontSizeMultiplier={1.3} style={styles.name}>
                {store.callSign ?? copy.notPaired}
              </Text>
              <View style={styles.identityMeta}>
                <View style={styles.liveDot} />
                <Text maxFontSizeMultiplier={1.2} style={styles.identityCaption}>
                  {vehicleTypeLabel(store.vehicleType)} · {copy.onDuty}
                </Text>
              </View>
            </View>
          </View>

          <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
            {copy.thisShift}
          </Text>
          <View style={styles.stats}>
            <Stat value={String(responses)} label={copy.responses} />
            <Stat value={store.pendingCount === 0 ? '0' : String(store.pendingCount)} label="queued" />
            <Stat value={store.serverTime === null ? '—' : lastSync} label="last sync" />
          </View>

          {store.lastCheck === null ? null : (
            <View style={styles.checkRow}>
              <Icon
                color={
                  checkIsFresh(store.lastCheck.at, store.nowMs)
                    ? colors.accent
                    : colors.secondary
                }
                name="check"
                size={16}
              />
              <Text maxFontSizeMultiplier={1.2} style={styles.checkText}>
                {`${store.lastCheck.kind === 'handover' ? copy.handoverTitle : copy.checkTitle} · ${
                  store.lastCheck.count
                } items · ${
                  checkIsFresh(store.lastCheck.at, store.nowMs)
                    ? `${copy.checkExpires} ${formatClock(
                        checkExpiresAt(store.lastCheck.at)
                      ) ?? '—'}`
                    : copy.checkExpired
                }`}
              </Text>
            </View>
          )}

          <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
            {copy.security}
          </Text>
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <View style={styles.rowIcon}>
                <Icon color={colors.accent} name="fingerprint" size={18} />
              </View>
              <View style={styles.grow}>
                <Text maxFontSizeMultiplier={1.3} style={styles.switchLabel}>
                  Fingerprint unlock
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.switchHint}>
                  Ask on app open
                </Text>
              </View>
              <Switch
                accessibilityLabel="Fingerprint unlock"
                onValueChange={setFingerprint}
                thumbColor={fingerprint ? colors.accent : undefined}
                trackColor={{ false: colors.inset, true: 'rgba(201,249,76,0.35)' }}
                value={fingerprint}
              />
            </View>
            <View style={styles.rule} />
            <View style={styles.switchRow}>
              <View style={styles.rowIcon}>
                <Icon color={colors.secondary} name="shield" size={18} />
              </View>
              <View style={styles.grow}>
                <Text maxFontSizeMultiplier={1.3} style={styles.switchLabel}>
                  {copy.requirePin}
                </Text>
                <Text maxFontSizeMultiplier={1.2} style={styles.switchHint}>
                  For closing a response
                </Text>
              </View>
              <Switch
                accessibilityLabel={copy.requirePin}
                onValueChange={setRequirePin}
                thumbColor={requirePin ? colors.accent : undefined}
                trackColor={{ false: colors.inset, true: 'rgba(201,249,76,0.35)' }}
                value={requirePin}
              />
            </View>
          </View>

          <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
            Tools
          </Text>
          <Pressable
            accessibilityLabel={copy.duty}
            accessibilityRole="button"
            onPress={() => store.push({ name: 'duty' })}
            style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
          >
            <Icon color={colors.secondary} name="clock" size={18} />
            <Text maxFontSizeMultiplier={1.3} style={styles.linkLabel}>
              {copy.duty} · shift timer
            </Text>
            <Icon color={colors.secondary} name="chevronRight" size={18} />
          </Pressable>
          <Pressable
            accessibilityLabel={copy.checklist}
            accessibilityRole="button"
            onPress={() => store.push({ name: 'checklist' })}
            style={({ pressed }) => [styles.link, styles.spaced, pressed && styles.linkPressed]}
          >
            <Icon color={colors.secondary} name="checkSquare" size={18} />
            <Text maxFontSizeMultiplier={1.3} style={styles.linkLabel}>
              {copy.checklist}
            </Text>
            <Icon color={colors.secondary} name="chevronRight" size={18} />
          </Pressable>

          <Text maxFontSizeMultiplier={1.2} style={styles.sectionLabel}>
            {copy.dispatchSection}
          </Text>
          <View style={styles.card}>
            <Row label={copy.dispatchHost} icon="signal" value={apiBaseHost()} />
            <View style={styles.rule} />
            <Row label={copy.lastSync} value={lastSync} />
            <View style={styles.rule} />
            <Row label={copy.pendingUpdates} value={String(store.pendingCount)} />
            <View style={styles.rule} />
            <Row label={copy.appVersion} value={version} />
          </View>

          <Pressable
            accessibilityLabel={copy.unpair}
            accessibilityRole="button"
            onPress={() => setConfirming(true)}
            style={({ pressed }) => [styles.unpair, pressed && styles.unpairPressed]}
          >
            <Icon color={colors.danger} name="close" size={18} />
            <Text maxFontSizeMultiplier={1.3} style={styles.unpairLabel}>
              {copy.unpair}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <Sheet
        footer={
          <>
            <Pressable
              accessibilityLabel={copy.unpair}
              accessibilityRole="button"
              onPress={() => {
                setConfirming(false);
                void store.unpair();
              }}
              style={styles.destructive}
            >
              <Text maxFontSizeMultiplier={1.3} style={styles.destructiveLabel}>
                {copy.unpair}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={copy.cancel}
              accessibilityRole="button"
              onPress={() => setConfirming(false)}
              style={styles.cancel}
            >
              <Text maxFontSizeMultiplier={1.3} style={styles.cancelLabel}>
                {copy.cancel}
              </Text>
            </Pressable>
          </>
        }
        onClose={() => setConfirming(false)}
        title={copy.unpairTitle}
        visible={confirming}
      >
        <Text maxFontSizeMultiplier={1.3} style={styles.sheetBody}>
          {copy.unpairBody}
        </Text>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  column: {
    width: '100%',
    maxWidth: contentMaxWidth,
    alignSelf: 'center',
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  avatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(201,249,76,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(201,249,76,0.30)',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: colors.text,
    fontSize: typeScale.section,
    fontWeight: weight.strong,
    letterSpacing: -0.4,
  },
  identityMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
    marginEnd: 6,
  },
  identityCaption: {
    color: colors.secondary,
    fontSize: typeScale.meta,
  },
  sectionLabel: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: weight.medium,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stat: {
    flex: 1,
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  statValue: {
    color: colors.text,
    fontSize: typeScale.section,
    fontWeight: weight.strong,
    letterSpacing: -0.4,
  },
  statLabel: {
    color: colors.secondary,
    fontSize: 13,
    marginTop: 2,
  },
  card: {
    backgroundColor: colors.raised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.sm,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.inset,
  },
  switchLabel: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 22,
  },
  switchHint: {
    color: colors.secondary,
    fontSize: 13,
    marginTop: 1,
  },
  rule: {
    height: 1,
    backgroundColor: colors.hairline,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.inset,
  },
  checkText: {
    flex: 1,
    color: colors.secondary,
    fontSize: 12.5,
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  rowLabel: {
    color: colors.secondary,
    fontSize: typeScale.secondary,
    flexShrink: 1,
  },
  rowValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  rowValue: {
    color: colors.text,
    fontSize: typeScale.secondary,
    textAlign: 'right',
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  linkPressed: {
    opacity: 0.8,
  },
  linkLabel: {
    flex: 1,
    color: colors.text,
    fontSize: typeScale.secondary,
  },
  spaced: {
    marginTop: spacing.sm,
  },
  unpair: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 58,
    marginTop: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: 'rgba(229,103,79,0.06)',
  },
  unpairPressed: {
    backgroundColor: 'rgba(229,103,79,0.14)',
  },
  unpairLabel: {
    color: colors.danger,
    fontSize: typeScale.body,
    fontWeight: weight.medium,
  },
  destructive: {
    minHeight: 58,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destructiveLabel: {
    color: colors.danger,
    fontSize: typeScale.body,
    fontWeight: weight.medium,
  },
  cancel: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  cancelLabel: {
    color: colors.secondary,
    fontSize: typeScale.body,
    fontWeight: weight.medium,
  },
  sheetBody: {
    color: colors.text,
    fontSize: typeScale.secondary,
    lineHeight: 26,
    marginBottom: spacing.sm,
  },
});
